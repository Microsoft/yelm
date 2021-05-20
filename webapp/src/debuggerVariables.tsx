import * as React from "react";
import * as data from "./data";
import * as simulator from "./simulator";
import { DebuggerTable, DebuggerTableRow } from "./debuggerTable";

const MAX_VARIABLE_LENGTH = 20;

interface ScopeVariables {
    title: string;
    variables: Variable[];
    key?: string;
}

interface Variable {
    name: string;
    value: any;
    displayName?: string;
    id?: number;
    prevValue?: any;
    children?: Variable[];
}

interface PreviewState {
    id: number;
    top: number;
    left: number;
}

interface DebuggerVariablesProps {
    apis: pxt.Map<pxtc.SymbolInfo>;
    sequence: number;
    breakpoint?: pxsim.DebuggerBreakpointMessage;
    filters?: string[]
    activeFrame?: number;
}

interface DebuggerVariablesState {
    globalFrame: ScopeVariables;
    stackFrames: ScopeVariables[];
    nextID: number;
    renderedSequence?: number;

    frozen?: boolean;

    preview: PreviewState | null;
}

export class DebuggerVariables extends data.Component<DebuggerVariablesProps, DebuggerVariablesState> {
    constructor(props: DebuggerVariablesProps) {
        super(props);
        this.state = {
            globalFrame: {
                title: lf("Globals"),
                variables: []
            },
            stackFrames: [],
            nextID: 0,
            preview: null
        };

    }

    clear() {
        this.setState({
            globalFrame: {
                title: this.state.globalFrame.title,
                variables: []
            },
            stackFrames: [],
            preview: null
        });
    }

    update(frozen = false) {
        this.setState({ frozen, preview: frozen ? null : this.state.preview });
    }

    componentDidUpdate(prevProps: DebuggerVariablesProps) {
        if (this.props.breakpoint) {
            if (this.props.sequence != this.state.renderedSequence) {
                this.updateVariables(this.props.breakpoint, this.props.filters);
            }
        }
        else if (!this.state.frozen) {
            this.update(true);
        }
    }

    renderCore() {
        const { globalFrame, stackFrames, frozen, preview } = this.state;
        const { activeFrame, breakpoint } = this.props;
        const variableTableHeader = lf("Variables");
        let variables = globalFrame.variables;

        // Add in the local variables.
        // TODO: Handle callstack
        if (stackFrames && stackFrames.length && activeFrame !== undefined) {
            variables = stackFrames[activeFrame].variables.concat(variables);
        }

        let placeholderText: string;

        if (frozen) {
            placeholderText = lf("Code is running...");
        }
        else if (!variables.length && !breakpoint?.exceptionMessage) {
            placeholderText = lf("No variables to show");
        }

        const tableRows = placeholderText ? [] : this.renderVars(variables);

        if (breakpoint?.exceptionMessage && !frozen) {
            tableRows.unshift(<DebuggerTableRow
                leftText={lf("Exception:")}
                leftClass="exception"
                key="exception-message"
                rightText={truncateLength(breakpoint.exceptionMessage)}
                rightTitle={breakpoint.exceptionMessage}
            />);
        }

        const previewVar = this.getVariableById(preview?.id);
        const previewLabel = previewVar && lf("Current value for '{0}'", previewVar.name);

        return <div>
            <DebuggerTable header={variableTableHeader} placeholderText={placeholderText}>
                {tableRows}
            </DebuggerTable>
            { preview &&
                <div id="debugger-preview"
                    role="tooltip"
                    className="debugger-preview"
                    ref={this.handlePreviewRef}
                    tabIndex={0}
                    aria-label={previewLabel}
                    style={{
                        top: `${preview.top}px`,
                        left: `${preview.left}px`
                    }}>
                        {renderValue(previewVar.value)}
                    </div>
            }
        </div>
    }

    renderVars(vars: Variable[], depth = 0, result: JSX.Element[] = []) {
        const previewed = this.state.preview?.id;

        vars.forEach(varInfo => {
            const valueString = renderValue(varInfo.value);
            const typeString = variableType(varInfo);
            const displayName = varInfo.displayName || varInfo.name;

            result.push(<DebuggerTableRow key={varInfo.id}
                describedBy={varInfo.id === previewed ? "debugger-preview" : undefined}
                refID={varInfo.id}
                icon={(varInfo.value && varInfo.value.hasFields) ? (varInfo.children ? "down triangle" : "right triangle") : undefined}
                leftText={displayName + ":"}
                leftTitle={displayName}
                leftClass={varInfo.prevValue !== undefined ? "changed" : undefined}
                rightText={truncateLength(valueString)}
                rightTitle={shouldShowValueOnHover(typeString) ? valueString : undefined}
                rightClass={typeString}
                onClick={this.handleComponentClick}
                onValueClick={this.handleValueClick}
                depth={depth}
            />)

            if (varInfo.children) {
                this.renderVars(varInfo.children, depth + 1, result);
            }
        });
        return result;
    }

    updateVariables(
        breakpoint: pxsim.DebuggerBreakpointMessage,
        filters?: string[]
    ) {
        const { globals, environmentGlobals, stackframes } = breakpoint;
        if (!globals && !environmentGlobals) {
            // freeze the ui
            this.update(true)
            return;
        }

        let nextId = 0;

        const updatedGlobals = updateScope(this.state.globalFrame, globals);
        if (filters) {
            updatedGlobals.variables = updatedGlobals.variables.reduce(
                (acc, v) => {
                    const matchingVar = filters.find(fv => pxtc.escapeIdentifier(pxt.blocks.escapePictographic(fv)) === v.name);
                    if (matchingVar) {
                        v.displayName = matchingVar;
                        acc.push(v);
                    }
                    return acc;
                }, [] as Variable[]
            );
        }
        // inject unfiltered environment variables
        if (environmentGlobals)
            updatedGlobals.variables = updatedGlobals.variables.concat(variablesToVariableList(environmentGlobals));

        assignVarIds(updatedGlobals.variables);

        let updatedFrames: ScopeVariables[];
        if (stackframes) {
            const oldFrames = this.state.stackFrames;

            updatedFrames = stackframes.map((sf, index) => {
                const key = sf.breakpointId + "_" + index;

                for (const frame of oldFrames) {
                    if (frame.key === key) return updateScope(frame, sf.locals, getArgArray(sf.arguments));
                }

                return updateScope({ key, title: sf.funcInfo.functionName, variables: [] }, sf.locals, getArgArray(sf.arguments))
            });

            updatedFrames.forEach(sf => assignVarIds(sf.variables));
        }

        this.setState({
            globalFrame: updatedGlobals,
            stackFrames: updatedFrames || [],
            nextID: nextId,
            renderedSequence: this.props.sequence,
            frozen: false
        });

        function getArgArray(info: pxsim.FunctionArgumentsInfo): Variable[] {
            if (info) {
                if (info.thisParam != null) {
                    return [{ name: "this", value: info.thisParam }, ...info.params]
                }
                else {
                    return info.params;
                }
            }
            return []
        }

        function assignVarIds(vars: Variable[]) {
            vars.forEach(v => {
                v.id = nextId++
                if (v.children) assignVarIds(v.children)
            });
        }
    }

    protected getVariableById(id: number) {
        if (id === null) return null;
        for (const v of this.getFullVariableList()) {
            if (v.id === id) {
                return v;
            }
        }
        return null;
    }

    protected handleComponentClick = (e: React.SyntheticEvent<HTMLDivElement>, component: DebuggerTableRow) => {
        if (this.state.frozen) return;

        const variable = this.getVariableById(component.props.refID as number);

        if (variable) {
            this.toggle(variable);

            if (this.state.preview !== null) {
                this.setState({
                    preview: null
                });
            }
        }
    }

    protected handleValueClick = (e: React.SyntheticEvent<HTMLDivElement>, component: DebuggerTableRow) => {
        if (this.state.frozen) return;

        const id = component.props.refID;
        const bb = (e.target as HTMLDivElement).getBoundingClientRect();
        this.setState({
            preview: {
                id: id as number,
                top: bb.top,
                left: bb.left
            }
        });
    }

    protected handlePreviewRef = (ref: HTMLDivElement) => {
        if (ref) {
            const previewed = this.state.preview;
            ref.focus();
            ref.addEventListener("blur", () => {
                if (this.state.preview?.id === previewed.id) {
                    this.setState({
                        preview: null
                    });
                }
            });
            const select = window.getSelection();
            select.removeAllRanges();
            const range = document.createRange();
            range.selectNodeContents(ref);
            select.addRange(range);
        }
    }

    protected getFullVariableList() {
        let result: Variable[] = [];

        collectVariables(this.state.globalFrame.variables);
        if (this.state.stackFrames) this.state.stackFrames.forEach(sf => collectVariables(sf.variables));

        return result;

        function collectVariables(vars: Variable[]) {
            vars.forEach(v => {
                result.push(v);
                if (v.children) {
                    collectVariables(v.children)
                }
            });
        }
    }

    private toggle(v: Variable) {
        // We have to take care of the logic for nested looped variables. Currently they break this implementation.
        if (v.children) {
            delete v.children;
            this.setState({ globalFrame: this.state.globalFrame })
        } else {
            if (!v.value || !v.value.id) return;
            // We filter the getters we want to call for this variable.
            let allApis = this.props.apis;
            let matcher = new RegExp("^((.+\.)?" + v.value.type + ")\.");
            let potentialKeys = Object.keys(allApis).filter(key => matcher.test(key));
            let fieldsToGet: string[] = [];

            potentialKeys.forEach(key => {
                let symbolInfo = allApis[key];
                if (!key.endsWith("@set") && symbolInfo && symbolInfo.attributes.callInDebugger) {
                    fieldsToGet.push(key);
                }
            });

            simulator.driver.variablesAsync(v.value.id, fieldsToGet)
                .then((msg: pxsim.VariablesMessage) => {
                    if (msg && msg.variables) {
                        let nextID = this.state.nextID;
                        v.children = Object.keys(msg.variables).map(key => ({ name: key, value: msg.variables[key], id: nextID++ }))
                        this.setState({ globalFrame: this.state.globalFrame, nextID })
                    }
                })
        }
    }
}

function variablesToVariableList(newVars: pxsim.Variables) {
    const current = Object.keys(newVars).map(varName => ({
        name: fixVarName(varName),
        value: newVars[varName]
    }));
    return current;
}

function updateScope(lastScope: ScopeVariables, newVars: pxsim.Variables, params?: Variable[]): ScopeVariables {
    let current = variablesToVariableList(newVars);

    if (params) {
        current = params.concat(current);
    }

    return {
        ...lastScope,
        variables: getUpdatedVariables(lastScope.variables, current)
    };
}

function fixVarName(name: string) {
    return name.replace(/___\d+$/, "");
}

function getUpdatedVariables(previous: Variable[], current: Variable[]): Variable[] {
    return current.map(v => {
        const prev = getVariable(previous, v);
        if (prev && prev.value && !prev.value.id && prev.value !== v.value) {
            return {
                ...v,
                prevValue: prev.value
            }
        }
        return v
    });
};

function getVariable(variables: Variable[], value: Variable) {
    for (let i = 0; i < variables.length; i++) {
        if (variables[i].name === value.name) {
            return variables[i];
        }
    }
    return undefined;
}

function renderValue(v: any): string {
    let sv = '';
    let type = typeof v;
    switch (type) {
        case "undefined": sv = "undefined"; break;
        case "number": sv = v + ""; break;
        case "boolean": sv = v + ""; break;
        case "string": sv = JSON.stringify(v); break;
        case "object":
            if (v == null) sv = "null";
            else if (v.text) sv = v.text;
            else if (v.id && v.preview) return v.preview;
            else if (v.id !== undefined) sv = "(object)"
            else sv = "(unknown)"
            break;
    }
    return sv;
}

function truncateLength(varstr: string) {
    let remaining = MAX_VARIABLE_LENGTH - 3; // acount for ...
    let hasQuotes = false;
    if (varstr.indexOf('"') == 0) {
        remaining -= 2;
        hasQuotes = true;
        varstr = varstr.substring(1, varstr.length - 1);
    }
    if (varstr.length > remaining)
        varstr = varstr.substring(0, remaining) + '...';
    if (hasQuotes) {
        varstr = '"' + varstr + '"'
    }
    return varstr;
}

function variableType(variable: Variable): string {
    let val = variable.value;
    if (val == null) return "undefined";
    let type = typeof val
    switch (type) {
        case "string":
        case "number":
        case "boolean":
            return type;
        case "object":
            if (val.type) return val.type;
            if (val.preview) return val.preview;
            if (val.text) return val.text;
            return "object";
        default:
            return "unknown";
    }
}

function shouldShowValueOnHover(type: string): boolean {
    switch (type) {
        case "string":
        case "number":
        case "boolean":
        case "array":
            return true;
        default:
            return false;
    }
}
