/// <reference path="../../built/pxtlib.d.ts" />

import * as React from "react";
import * as data from "./data";
import * as sui from "./sui";
import * as compiler from "./compiler";

type ISettingsProps = pxt.editor.ISettingsProps;

interface TutorialCodeValidationProps extends ISettingsProps {
    onYesButtonClick: () => void;
    onNoButtonClick: () => void;
    validationTelemetry: (command: string) => void;
    initialVisible: boolean;
    isTutorialCodeInvalid: boolean;
    ruleComponents: pxt.tutorial.TutorialRuleStatus[];
    areStrictRulesPresent: boolean;
}

interface TutorialCodeValidationState {
    visible: boolean;
    ruleBlocks?: pxt.Map<string[]>;
}

export class ShowValidationMessage extends data.Component<TutorialCodeValidationProps, TutorialCodeValidationState> {
    protected renderedBlockCache: pxt.Map<string> = {};

    constructor(props: TutorialCodeValidationProps) {
        super(props);

        this.state = { visible: this.props.initialVisible, ruleBlocks: {} };
    }

    showTutorialValidationMessage(vis: boolean) {
        this.setState({ visible: vis });
    }

    moveOnToNextTutorialStep() {
        this.props.validationTelemetry("continue");
        this.props.onYesButtonClick();
        this.showTutorialValidationMessage(false);
    }

    stayOnThisTutorialStep() {
        this.props.validationTelemetry("edit");
        this.props.onNoButtonClick();
    }

    componentDidMount() {
        this.props.ruleComponents.forEach(rule => {
            if (rule.blockIds && !this.state.ruleBlocks?.[rule.ruleName]?.length) {
                this.getRuleBlocksAsync(rule);
            }
        })
    }

    UNSAFE_componentWillReceiveProps(nextProps: TutorialCodeValidationProps, nextState: TutorialCodeValidationState) {
        nextProps.ruleComponents.forEach(rule => {
            const prev = this.props.ruleComponents.find(r => r.ruleName == rule.ruleName);
            // Update if the list of blockids is different
            if ((rule.blockIds && rule.blockIds.sort().toString() != prev?.blockIds?.sort()?.toString())
                || rule.blockIds?.length != nextState.ruleBlocks?.[rule.ruleName]?.length) {
                this.getRuleBlocksAsync(rule);
            }
        })
    }

    renderRule(rule: pxt.tutorial.TutorialRuleStatus, index?: number) {
        const blockUris = this.state.ruleBlocks?.[rule.ruleName];
        if (!blockUris) {
            return <p key={index + rule.ruleName}>{(rule.ruleTurnOn && !rule.ruleStatus) ? rule.ruleMessage : ''}</p>
        } else {
            return <div>
                <div className="codeValidationPopUpText">{rule.ruleTurnOn && !rule.ruleStatus ? rule.ruleMessage : ''}</div>
                <div className="validationRendering">
                    {blockUris.map((blockUri, index) => <div> <img key={index + blockUri + rule.ruleName} src={blockUri} alt="block rendered" /></div>)}
                </div>
            </div>

        }
    }

    getRuleBlocksAsync(rule: pxt.tutorial.TutorialRuleStatus) {
        if (rule.blockIds) {
            // Get all APIs from compiler
            compiler.getBlocksAsync().then(blocksInfo => {
                return Promise.all(rule.blockIds.map(id => {
                    if (this.renderedBlockCache[id]) return Promise.resolve(this.renderedBlockCache[id]);

                    const symbol = blocksInfo.blocksById[id];
                    if (!symbol) return Promise.resolve(undefined);

                    // Render toolbox block from symbol info
                    const fn = pxt.blocks.blockSymbol(id);
                    if (fn) {
                        const comp = pxt.blocks.compileInfo(fn);
                        const blockXml = pxt.blocks.createToolboxBlock(blocksInfo, fn, comp);
                        const svg = pxt.blocks.render(`<xml xmlns="https://developers.google.com/blockly/xml">${blockXml.outerHTML}</xml>`,
                            { snippetMode: true, splitSvg: false }) as SVGSVGElement;
                        const viewBox = svg.getAttribute("viewBox").split(/\s+/).map(d => parseInt(d));
                        return pxt.blocks.layout.blocklyToSvgAsync(svg, viewBox[0], viewBox[1], viewBox[2], viewBox[3])
                            .then(sg => {
                                if (!sg) return Promise.resolve<string>(undefined);
                                return pxt.BrowserUtils.encodeToPngAsync(sg.xml, { width: sg.width, height: sg.height, pixelDensity: 1 });
                            })
                    }

                    return Promise.resolve(undefined)
                })).then(blockUris => {
                    this.setState({
                        ruleBlocks: {
                            ...this.state.ruleBlocks,
                            [rule.ruleName]: blockUris.filter(b => !!b)
                        }
                    });
                })
            })
        }
    }

    renderCore() {
        const codeInvalid = this.props.isTutorialCodeInvalid;
        const rules = this.props.ruleComponents;
        const rulesDefined = (rules != undefined);
        const strictRulePresent = this.props.areStrictRulesPresent;
        return <div>
            {this.state.visible && <div className="mask" role="region" onClick={this.props.onNoButtonClick} />}
            <div className={`tutorialCodeValidation no-select ${(!codeInvalid || (codeInvalid && !strictRulePresent)) ? 'hidden' : ''}`}>
                <div>
                    {rulesDefined && rules.map((rule, index) => this.renderRule(rule, index))}
                </div>
                <div className="codeValidationPopUpText">
                    {lf("Do you still want to continue?")}
                </div>
                <div className="moveOnButtons">
                    <sui.Button className="yes" ariaLabel={lf("yes button for tutorial code validation")} onClick={this.moveOnToNextTutorialStep.bind(this)} onKeyDown={sui.fireClickOnEnter} > {lf("Continue Anyway")} </sui.Button>
                    <sui.Button className="no" ariaLabel={lf("no button for tutorial code validation")} onClick={this.stayOnThisTutorialStep.bind(this)} onKeyDown={sui.fireClickOnEnter} > {lf("Keep Editing")} </sui.Button>
                </div>
            </div>
        </div>;
    }
}
