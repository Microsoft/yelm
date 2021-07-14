import * as React from "react";
import * as compiler from "./compiler"
import * as core from "./core";
import * as toolbox from "./toolbox";
import * as workspace from "./workspace";
import * as data from "./data";
import * as auth from "./auth";

const DRAG_THRESHOLD = 5;
const SELECTED_BORDER_WIDTH = 4;

interface BlockDragInfo {
    x: number;
    y: number;
    block?: toolbox.BlockDefinition;
    snippet?: string;
    color?: string;
}

export interface MonacoFlyoutProps extends pxt.editor.ISettingsProps {
    fileType?: pxt.editor.FileType;
    blockIdMap?: pxt.Map<string[]>;
    moveFocusToParent?: () => void;
    insertSnippet?: (position: monaco.Position, insertText: string, inline?: boolean) => void;
    setInsertionSnippet?: (snippet: string) => void;
}

export interface MonacoFlyoutState {
    name?: string;
    ns?: string;
    color?: string;
    icon?: string;
    groups?: toolbox.GroupDefinition[];
    selectedBlock?: string;
    hoverBlock?: string;
    hide?: boolean;
}

export class MonacoFlyout extends data.Component<MonacoFlyoutProps, MonacoFlyoutState> {
    protected dragging: boolean = false;
    protected dragInfo: BlockDragInfo;
    protected lastSelected: string;

    constructor(props: MonacoFlyoutProps) {
        super(props);
        this.state = {};
    }

    componentDidMount() {
        if (pxt.BrowserUtils.hasPointerEvents()) {
            document.addEventListener("pointermove", this.blockDragHandler);
            document.addEventListener("pointerup", this.blockDragEndHandler);
        } else {
            document.addEventListener("mousemove", this.blockDragHandler);
            document.addEventListener("mouseup", this.blockDragEndHandler);
            if (pxt.BrowserUtils.isTouchEnabled()) {
                document.addEventListener("touchmove", this.blockDragHandler);
                document.addEventListener("touchend", this.blockDragEndHandler);
            }
        }
    }

    componentWillUnmount() {
        if (pxt.BrowserUtils.hasPointerEvents()) {
            document.removeEventListener("pointermove", this.blockDragHandler);
            document.removeEventListener("pointerup", this.blockDragEndHandler);
        } else {
            document.removeEventListener("mousemove", this.blockDragHandler);
            document.removeEventListener("mouseup", this.blockDragEndHandler);
            if (pxt.BrowserUtils.isTouchEnabled()) {
                document.removeEventListener("touchmove", this.blockDragHandler);
                document.removeEventListener("touchend", this.blockDragEndHandler);
            }
        }
    }

    componentDidUpdate() {
        this.positionDragHandle();
    }

    protected getBlockClickHandler = (name: string) => {
        return () => {
            pxt.tickEvent("monaco.toolbox.itemclick", undefined, { interactiveConsent: true });
            this.setState({ selectedBlock: name != this.state.selectedBlock ? name : undefined });
        };
    }

    protected getBlockMouseOver = (name: string) => {
        return () => {
            pxt.tickEvent("monaco.toolbox.itemmouseover");
            this.setState({ hoverBlock: name != this.state.hoverBlock ? name : undefined});
        };
    }

    protected getBlockMouseOut = (name: string) => {
        return () => { if (name == this.state.hoverBlock ) this.setState({ hoverBlock: undefined }) };
    }

    protected getBlockDragStartHandler = (block: toolbox.BlockDefinition, snippet: string, color: string) => {
        return (e: any) => {
            this.dragInfo = {
                x: pxt.BrowserUtils.getClientX(e),
                y: pxt.BrowserUtils.getClientY(e),
                block,
                snippet,
                color
            };
        }
    }

    protected isHorizontalDrag = (e: any) => {
        const dX = Math.abs(this.dragInfo.x - pxt.BrowserUtils.getClientX(e));
        const dY = Math.abs(this.dragInfo.y - pxt.BrowserUtils.getClientY(e))
        return dX > DRAG_THRESHOLD && dY > DRAG_THRESHOLD && dX > dY;
    }

    protected blockDragHandler = (e: any) => {
        let dragBlock = document.getElementById("monacoDraggingBlock");
        if (this.dragInfo && (dragBlock || this.isHorizontalDrag(e))) {
            pxt.tickEvent("monaco.toolbox.itemdrag", undefined, { interactiveConsent: true });
            e.preventDefault();
            e.stopPropagation();

            const block = this.dragInfo.block;
            const params = block.parameters;
            this.dragging = true;
            if (!dragBlock) {
                const parent = document.getElementById("root");
                parent.style.overflow = "hidden";
                dragBlock = document.createElement("div");
                dragBlock.id = "monacoDraggingBlock";
                dragBlock.textContent = block.snippetOnly
                    ? block.snippet
                    : `${this.getQName(block) || this.getSnippetName(block)}${params ? `(${params.map(p => p.name).join(", ")})` : ""}`
                dragBlock.style.backgroundColor = this.dragInfo.color;
                parent.appendChild(dragBlock);

                // Fire a create event
                workspace.fireEvent({ type: 'create', editor: 'ts', blockId: block.attributes.blockId } as pxt.editor.events.CreateEvent);
                let inline = "";
                if (block.retType != "void") {
                    inline = "inline:1&";
                }
                this.props.setInsertionSnippet(this.dragInfo.snippet || inline + "qName:" + block.qName);
            }
            dragBlock.style.top = `${pxt.BrowserUtils.getClientY(e)}px`;
            dragBlock.style.left = `${pxt.BrowserUtils.getClientX(e)}px`;
            // For devices without PointerEvents (iOS < 13.0) use state to
            // hide the flyout rather than focusing the editor
            this.setState({ hide: true });
        }
    }

    protected blockDragEndHandler = (e: any) => {
        this.dragInfo = undefined;
        this.dragging = false;
        this.props.setInsertionSnippet(undefined);
        const block = document.getElementById("monacoDraggingBlock");
        if (block) block.remove();
        const parent = document.getElementById("root");
        parent.style.overflow = "";
    }

    protected getKeyDownHandler = (block?: toolbox.BlockDefinition, snippet?: string, isPython?: boolean) => {
        return (e: any) => {
            const isRtl = pxt.Util.isUserLanguageRtl();
            const charCode = core.keyCodeFromEvent(e);
            const target = e.target as HTMLElement;
            if (charCode == 40) { //  DOWN
                // Next item
                let nextSibling = target.nextElementSibling as HTMLElement;
                if (target && nextSibling) {
                    nextSibling.click();
                    nextSibling.focus();
                }
            } else if (charCode == 38) { // UP
                // Previous item
                let prevSibling = target.previousElementSibling as HTMLElement;
                if (target && prevSibling) {
                    prevSibling.click();
                    prevSibling.focus();
                }
            } else if ((charCode == 37 && !isRtl) || (charCode == 38 && isRtl)) { // (LEFT & LTR) or (RIGHT & RTL)
                // Focus back to toolbox
                this.props.moveFocusToParent();
            } else if (charCode == 27) { // ESCAPE
                // Focus back to toolbox and close Flyout
                this.setState({ groups: undefined });
                this.props.moveFocusToParent();
            } else if (charCode == 13 && block) { // ENTER
                let p = snippet ? Promise.resolve(snippet) : compiler.snippetAsync(block.qName, isPython);
                p.then(snip => {
                    this.props.insertSnippet(null, snip, block.retType != "void");
                    // Fire a create event
                    workspace.fireEvent({ type: 'create', editor: 'ts', blockId: block.attributes.blockId } as pxt.editor.events.CreateEvent);
                });
            }
        }
    }

    protected getHelpButtonClickHandler = (group?: string) => {
        return () => {
            pxt.debug(`${group} help icon clicked.`);
            workspace.fireEvent({ type: 'ui', editor: 'ts', action: 'groupHelpClicked', data: { group } } as pxt.editor.events.UIEvent);
        }
    }

    protected wheelHandler = (evt: any) => {
        evt.stopPropagation();
    }

    protected scrollHandler = (evt: any) => {
        this.positionDragHandle();
    }

    protected getFlyoutStyle = (): React.CSSProperties => {
        return {
            display: (this.state?.groups && !this.state?.hide) ? "block" : "none"
        }
    }

    protected getIconStyle = (color: string) => {
        return { color };
    }

    protected getSelectedStyle = () => {
        return { touchAction: pxt.BrowserUtils.hasPointerEvents() ? "pan-y" : undefined };
    }

    protected getBlockStyle = (color: string) => {
        const highContrast = this.getData<boolean>(pxt.auth.HIGHCONTRAST)
        return {
            backgroundColor: color,
            border: highContrast ? `2px solid ${color}` : "none",
            fontSize: `${this.props.parent.settings.editorFontSize}px`,
            lineHeight: `${this.props.parent.settings.editorFontSize + 16}px`
        };
    }

    protected getQName(block: toolbox.BlockDefinition): string {
        return this.props.fileType == pxt.editor.FileType.Python && block.pyQName ? block.pyQName : block.qName;
    }

    protected getSnippetName(block: toolbox.BlockDefinition): string {
        const isPython = this.props.fileType == pxt.editor.FileType.Python;
        return (isPython ? (block.pySnippetName || block.pyName) : undefined) || block.snippetName || block.name;
    }

    protected getBlockDescription(block: toolbox.BlockDefinition, params: pxtc.ParameterDesc[]): JSX.Element[] {
        let description = [];
        let compileInfo = pxt.blocks.compileInfo(block as pxtc.SymbolInfo)
        let parts = block.attributes._def && block.attributes._def.parts;
        let name = block.qName || block.name;
        const isPython = this.props.fileType == pxt.editor.FileType.Python;

        if (parts) {
            if (params &&
                parts.filter((p: any) => p.kind == "param").length > params.length) {
                // add empty param when first argument is "this"
                params.unshift(null);
            }
            parts.forEach((part, i) => {
                switch (part.kind) {
                    case "label":
                        description.push(<span key={name + i}>{part.text}</span>);
                        break;
                    case "break":
                        description.push(<span key={name + i}>{" "}</span>);
                        break;
                    case "param":
                        let actualParam = compileInfo?.definitionNameToParam[part.name];
                        let val = actualParam?.defaultValue
                            || part.varName
                            || actualParam?.actualName
                            || part.name
                        if (isPython && actualParam?.defaultValue) {
                            val = pxtc.tsSnippetToPySnippet(val);
                        }
                        description.push(<span className="argName" key={name + i}>{val}</span>);
                        break;
                }
            })
        } else {
            // if no blockdef found, use the snippet name
            description.push(<span key={name}>{this.getSnippetName(block) || block.name}</span>)
        }

        // imitates block behavior in adding "run code" before any handler
        let handler = params && params.find(p => p?.type && p.type.indexOf("=>") >= 0);
        if (handler) {
            description.unshift(<span key="prefix">{lf("run code ")}</span>)
            if (compileInfo?.handlerArgs) {
                // add break between end of block and parameters
                description.push(<span key="handler_break">{" "}</span>);
                compileInfo.handlerArgs.forEach((arg) => {
                    if (!arg.inBlockDef) {
                        description.push(<span className="argName" key={`handler_${arg.name}`}>{arg.name}</span>);
                    }
                })
            }
        }

        return description;
    }

    protected positionDragHandle(): void {
        let hoverHandle = document.querySelector(".monacoBlock.hover .blockHandle") as HTMLDivElement;
        if (hoverHandle) {
            let parent = hoverHandle.parentElement;
            let container = document.getElementById("monacoFlyoutWrapper");
            hoverHandle.style.height = `${parent.clientHeight}px`;
            hoverHandle.style.left = `${parent.clientWidth}px`;
            hoverHandle.style.top = `${parent.offsetTop - container.scrollTop}px`;
        }
        let expandHandle = document.querySelector(".monacoBlock.expand .blockHandle") as HTMLDivElement;
        if (expandHandle) {
            let parent = expandHandle.parentElement;
            let container = document.getElementById("monacoFlyoutWrapper");
            expandHandle.style.height = `${parent.clientHeight + (SELECTED_BORDER_WIDTH * 2)}px`;
            expandHandle.style.left = `${parent.clientWidth + SELECTED_BORDER_WIDTH - 1}px`;
            expandHandle.style.top = `${parent.offsetTop - container.scrollTop}px`;
        }
    }

    protected getMonacoBlock(block: toolbox.BlockDefinition, index: number, color: string): JSX.Element {
        if (block.snippet === undefined) return undefined;

        // Get block state (Visible, Hidden, Disabled)
        const { ns } = this.state;
        const filters = this.props.parent.state.editorState ? this.props.parent.state.editorState.filters : undefined;
        const categoryState = filters ? (filters.namespaces && filters.namespaces[ns] != undefined ? filters.namespaces[ns] : filters.defaultState) : undefined;
        const mappedIds = this.props.blockIdMap && this.props.blockIdMap[block.attributes.blockId];

        let fnState = filters ? filters.defaultState : pxt.editor.FilterState.Visible;
        if (filters && filters.fns && filters.fns[block.name] !== undefined) {
            fnState = filters.fns[block.name];
        } else if (filters && filters.blocks && block.attributes.blockId &&
            (filters.blocks[block.attributes.blockId] !== undefined || mappedIds?.some(id => filters.blocks[id]))) {
            fnState = filters.blocks[block.attributes.blockId];
        } else if (categoryState !== undefined) {
            fnState = categoryState;
        }
        if (fnState == pxt.editor.FilterState.Hidden) return undefined;

        // Get block DOM element
        const disabled = fnState == pxt.editor.FilterState.Disabled;
        const isPython = this.props.fileType == pxt.editor.FileType.Python;

        const snippet = isPython ? block.pySnippet : block.snippet;
        const params = block.parameters;
        const blockColor = block.attributes.color || color;
        const blockDescription = this.getBlockDescription(block, params ? params.slice() : null);
        const helpUrl = block.attributes.help;

        const qName = this.getQName(block) || this.getSnippetName(block);
        const selected = qName == this.state.selectedBlock;
        const hover = qName == this.state.hoverBlock;

        const hasPointer = pxt.BrowserUtils.hasPointerEvents();
        const hasTouch = pxt.BrowserUtils.isTouchEnabled();
        const dragStartHandler = this.getBlockDragStartHandler(block, snippet, blockColor);

        const description = block.attributes.jsDoc.replace(/``/g, '"')
            .split("* @param", 1)[0] // drop any kind of parameter annotation

        return <div className={`monacoBlock ${disabled ? "monacoDisabledBlock" : ""} ${selected ? "expand" : ""} ${hover ? "hover" : ""}`}
            style={this.getSelectedStyle()}
            title={block.attributes.jsDoc}
            key={`block_${qName}_${index}`} tabIndex={0} role="listitem"
            onClick={this.getBlockClickHandler(qName)}
            onMouseOver={this.getBlockMouseOver(qName)}
            onMouseOut={this.getBlockMouseOut(qName)}
            onKeyDown={this.getKeyDownHandler(block, snippet, isPython)}
            onPointerDown={hasPointer ? dragStartHandler : undefined}
            onMouseDown={!hasPointer ? dragStartHandler : undefined}
            onTouchStart={!hasPointer && hasTouch ? dragStartHandler : undefined}>
            <div className="blockHandle" style={this.getSelectedStyle()}><i className="icon bars" /></div>
            <div className="monacoDraggableBlock" style={this.getBlockStyle(blockColor)}>
                <span className="blockName">{blockDescription}</span>
            </div>
            <div className="detail">
                <div className="description">{description}</div>
                <div className="signature">
                    <span>{snippet ? snippet : `${qName}(${params ? params.map(p => `${p.name}`).join(", ") : ""})`}</span>
                    {helpUrl && <a className="blockHelp" href={`/reference/${helpUrl}`} target="_blank" rel="noopener noreferrer" role="button">
                        <i className="question circle outline icon" aria-label={lf("Open documentation")}></i>
                    </a>}
                </div>
                {params && <div className="params">
                    {params.map((p, i) => {
                        return <div key={i}>
                            <div className="separator"></div>
                            <span className="paramName">{p.name}</span>
                            {p.description && <span className="paramDescription">{p.description.replace(/``/g, '"')}</span>}
                        </div>
                    })}
                </div>}
            </div>
        </div>
    }

    renderCore() {
        const { name, ns, color, icon, groups } = this.state;
        const rgb = pxt.toolbox.convertColor(color || (ns && pxt.toolbox.getNamespaceColor(ns)) || "255");
        const iconClass = `blocklyTreeIcon${icon ? (ns || icon).toLowerCase() : "Default"}`.replace(/\s/g, "");
        return <div id="monacoFlyoutWidget" className="monacoFlyout" style={this.getFlyoutStyle()}>
            <div id="monacoFlyoutWrapper" onScroll={this.scrollHandler} onWheel={this.wheelHandler} role="list">
                <div className="monacoFlyoutLabel monacoFlyoutHeading">
                    <span className={`monacoFlyoutHeadingIcon blocklyTreeIcon ${iconClass}`} role="presentation" style={this.getIconStyle(rgb)}>
                        {(icon && icon.length === 1) ? icon : ""}
                    </span>
                    <div className="monacoFlyoutLabelText">{pxtc.U.rlf(`{id:category}${name}`)}</div>
                </div>
                {groups && groups.map((g, i) => {
                    let group: JSX.Element[] = [];
                    // Add group label, for non-default groups
                    if (g.name != pxt.DEFAULT_GROUP_NAME && groups.length > 1) {
                        group.push(
                            <div className="monacoFlyoutLabel blocklyFlyoutGroup" key={`label_${i}`} tabIndex={0} onKeyDown={this.getKeyDownHandler()} role="separator">
                                {g.icon && <span className={`monacoFlyoutHeadingIcon blocklyTreeIcon ${iconClass}`} role="presentation">{g.icon}</span>}
                                <div className="monacoFlyoutLabelText">{pxtc.U.rlf(`{id:group}${g.name}`)}</div>
                                {g.hasHelp && pxt.editor.HELP_IMAGE_URI && <span>
                                    <img src={pxt.editor.HELP_IMAGE_URI} onClick={this.getHelpButtonClickHandler(g.name)} alt={lf("Click for help")}>
                                    </img></span>}
                                <hr className="monacoFlyoutLabelLine" />
                            </div>)
                    }
                    // Add group blocks
                    if (g.blocks) {
                        let blocks = g.blocks.map((b, j) => {
                            // Check if the block is built in, ignore it as it's already defined in snippets
                            if (b.attributes.blockBuiltin) {
                                pxt.log("ignoring built in block: " + b.attributes.blockId);
                                return undefined;
                            } else {
                                return this.getMonacoBlock(b, j, rgb);
                            }
                        }).filter(b => b !== undefined);
                        if (blocks && blocks.length > 0) {
                            group = group.concat(blocks);
                        } else {
                            return null;
                        }
                    }
                    return group;
                })}
            </div>
        </div>
    }
}