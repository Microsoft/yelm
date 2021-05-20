/// <reference path="../../localtypings/pxtblockly.d.ts" />

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as pkg from "./package";
import * as core from "./core";
import * as toolboxeditor from "./toolboxeditor"
import * as compiler from "./compiler"
import * as toolbox from "./toolbox";
import * as snippets from "./blocksSnippets";
import * as workspace from "./workspace";
import * as simulator from "./simulator";
import * as dialogs from "./dialogs";
import * as blocklyFieldView from "./blocklyFieldView";
import { CreateFunctionDialog } from "./createFunction";
import { initializeSnippetExtensions } from './snippetBuilder';


import Util = pxt.Util;
import { DebuggerToolbox } from "./debuggerToolbox";
import { ErrorList } from "./errorList";
import { resolveExtensionUrl } from "./extensionManager";

export class Editor extends toolboxeditor.ToolboxEditor {
    editor: Blockly.WorkspaceSvg;
    currFile: pkg.File;
    delayLoadXml: string;
    typeScriptSaveable: boolean;
    loadingXml: boolean;
    loadingXmlPromise: Promise<any>;
    compilationResult: pxt.blocks.BlockCompilationResult;
    isFirstBlocklyLoad = true;
    functionsDialog: CreateFunctionDialog = null;

    showCategories: boolean = true;
    breakpointsByBlock: pxt.Map<number>; // Map block id --> breakpoint ID
    breakpointsSet: number[]; // the IDs of the breakpoints set.

    private errorChangesListeners: pxt.Map<(errors: pxt.blocks.BlockDiagnostic[]) => void> = {};

    protected debuggerToolbox: DebuggerToolbox;

    public nsMap: pxt.Map<toolbox.BlockDefinition[]>;

    constructor(parent: pxt.editor.IProjectView) {
        super(parent);

        this.listenToBlockErrorChanges = this.listenToBlockErrorChanges.bind(this)
        this.onErrorListResize = this.onErrorListResize.bind(this)
    }
    setBreakpointsMap(breakpoints: pxtc.Breakpoint[], procCallLocations: pxtc.LocationInfo[]): void {
        let map: pxt.Map<number> = {};
        if (!breakpoints || !this.compilationResult) return;
        breakpoints.forEach(breakpoint => {
            let blockId = pxt.blocks.findBlockIdByLine(this.compilationResult.sourceMap, { start: breakpoint.line, length: breakpoint.endLine - breakpoint.line });
            if (blockId) map[blockId] = breakpoint.id;
        });
        this.breakpointsByBlock = map;
    }

    setBreakpointsFromBlocks(): void {
        this.breakpointsSet = this.getBreakpoints();
        simulator.driver.setBreakpoints(this.breakpointsSet);
    }

    getBreakpoints() {
        const breakpoints: number[] = []
        const map = this.breakpointsByBlock;
        if (map && this.editor) {
            this.editor.getAllBlocks().forEach(block => {
                if (map[block.id] && block.isBreakpointSet()) {
                    breakpoints.push(this.breakpointsByBlock[block.id]);
                }
            });
        }
        return breakpoints;
    }

    addBreakpointFromEvent(blockId: string) {
        this.breakpointsSet.push(this.breakpointsByBlock[blockId]);
        simulator.driver.setBreakpoints(this.breakpointsSet);
    }

    removeBreakpointFromEvent(blockId: string) {
        let breakpointId = this.breakpointsByBlock[blockId];
        this.breakpointsSet.filter(breakpoint => breakpoint != breakpointId);
        simulator.driver.setBreakpoints(this.breakpointsSet);
    }

    clearBreakpoints(): void {
        simulator.driver.setBreakpoints([]);
    }

    handleKeyDown = (e: any) => {
        if (this.parent.state?.accessibleBlocks) {
            let charCode = (typeof e.which == "number") ? e.which : e.keyCode
            if (charCode === 84 /* T Key */) {
                this.focusToolbox();
                e.stopPropagation();
            }
        }
    }

    setVisible(v: boolean) {
        super.setVisible(v);
        this.isVisible = v;
        let classes = '#blocksEditor .blocklyToolboxDiv, #blocksEditor .blocklyWidgetDiv, #blocksEditor .blocklyToolboxDiv';
        if (this.isVisible) {
            pxt.Util.toArray(document.querySelectorAll(classes)).forEach((el: HTMLElement) => el.style.display = '');
            // Fire a resize event since the toolbox may have changed width and height.
            this.parent.fireResize();
        }
        else {
            pxt.Util.toArray(document.querySelectorAll(classes)).forEach((el: HTMLElement) => el.style.display = 'none');
            if (this.editor) Blockly.hideChaff();
            if (this.toolbox) this.toolbox.clearExpandedItem();
        }
    }

    saveToTypeScriptAsync(willOpenTypeScript = false): Promise<string> {
        if (!this.typeScriptSaveable) return Promise.resolve(undefined);
        this.clearHighlightedStatements();
        try {
            return pxt.blocks.compileAsync(this.editor, this.blockInfo, { emitTilemapLiterals: willOpenTypeScript })
                .then((compilationResult) => {
                    this.compilationResult = compilationResult;
                    pxt.tickEvent("activity.blocks.compile");

                    let next = Promise.resolve();
                    if (willOpenTypeScript && this.parent) {
                        // If we are opening TypeScript, clean up the temporary assets
                        // We need to do these steps in this order:
                        //   1. Remove the block data elements for each field
                        //   2. Save the XML with the blocks data removed (otherwise reloading the blocks will break)
                        //   3. Dispose of the temporary assets themselves
                        clearTemporaryAssetBlockData(this.editor)
                        next = this.parent.saveCurrentSourceAsync()
                            .then(() => disposeOfTemporaryAssets(this.editor))
                    }

                    return next.then(() => this.compilationResult.source)
                });
        } catch (e) {
            pxt.reportException(e)
            core.errorNotification(lf("Sorry, we were not able to convert this program."))
            return Promise.resolve(undefined);
        }
    }

    domUpdate() {
        if (this.delayLoadXml) {
            if (this.loadingXml) return
            pxt.debug(`loading blockly`)
            pxt.perf.measureStart("domUpdate loadBlockly")
            this.loadingXml = true

            const loadingDimmer = document.createElement("div");
            loadingDimmer.className = "ui active dimmer";
            const loading = document.createElement("div");
            loading.className = "ui text loader";
            loading.appendChild(document.createTextNode(lf("Loading blocks...")));
            loadingDimmer.appendChild(loading);
            let editorDiv = document.getElementById("blocksEditor");
            editorDiv.appendChild(loadingDimmer);

            compiler.clearCaches(); // ensure that we refresh the blocks list
            this.loadingXmlPromise = this.loadBlocklyAsync()
                .then(() => compiler.getBlocksAsync())
                .then(bi => {
                    this.blockInfo = bi;

                    // Initialize blocks in Blockly and update our toolbox
                    pxt.blocks.initialize(this.blockInfo);
                    this.nsMap = this.partitionBlocks();
                    this.refreshToolbox();

                    pxt.debug(`loading block workspace`)
                    let xml = this.delayLoadXml;
                    this.delayLoadXml = undefined;
                    this.loadBlockly(xml);

                    this.resize();
                    Blockly.svgResize(this.editor);
                    this.isFirstBlocklyLoad = false;
                }).finally(() => {
                    try {
                        // It's possible Blockly reloads and the loading dimmer is no longer a child of the editorDiv
                        editorDiv.removeChild(loadingDimmer);
                    } catch { }
                    this.loadingXml = false;
                    this.loadingXmlPromise = null;
                    pxt.perf.measureEnd("domUpdate loadBlockly")
                    // Do Not Remove: This is used by the skillmap
                    if (this.parent.isTutorial()) pxt.tickEvent("tutorial.editorLoaded")
                });
        }
    }

    isDropdownDivVisible(): boolean {
        return typeof Blockly !== "undefined"
            && Blockly.DropDownDiv
            && Blockly.DropDownDiv.isVisible();
    }

    beforeCompile() {
        // close all field editors to make sure
        // that all changes are commited
        // it is quite common for users to click download
        // while a field editor is still opened and the changes are not commited
        if (typeof Blockly === "undefined") return;

        Blockly.DropDownDiv.hide();
        Blockly.WidgetDiv.hide();
    }

    getTemporaryAssets(): pxt.Asset[] {
        if (!this.editor) return[];

        return pxtblockly.getTemporaryAssets(this.editor, pxt.AssetType.Image)
            .concat(pxtblockly.getTemporaryAssets(this.editor, pxt.AssetType.Animation))
    }

    updateTemporaryAsset(asset: pxt.Asset) {
        const block = this.editor.getBlockById(asset.meta.temporaryInfo.blockId);
        (block.getField(asset.meta.temporaryInfo.fieldName) as pxtblockly.FieldAssetEditor<any, any>).updateAsset(asset);
    }

    private saveBlockly(): string {
        // make sure we don't return an empty document before we get started
        // otherwise it may get saved and we're in trouble
        if (this.delayLoadXml) return this.delayLoadXml;
        return this.serializeBlocks();
    }

    private serializeBlocks(normalize?: boolean): string {
        // store ids when using github
        let xml = pxt.blocks.saveWorkspaceXml(this.editor,
            !normalize && this.parent.state
            && this.parent.state.header
            && !!this.parent.state.header.githubId);
        // strip out id, x, y attributes
        if (normalize) xml = xml.replace(/(x|y|id)="[^"]*"/g, '')
        pxt.debug(xml)
        return xml;
    }

    private loadBlockly(s: string): boolean {
        if (this.serializeBlocks() == s) {
            this.typeScriptSaveable = true;
            pxt.debug('blocks already loaded...');
            return false;
        }

        this.typeScriptSaveable = false;
        pxt.blocks.clearWithoutEvents(this.editor);
        try {
            const text = s || `<block type="${ts.pxtc.ON_START_TYPE}"></block>`;
            const xml = Blockly.Xml.textToDom(text);
            pxt.blocks.domToWorkspaceNoEvents(xml, this.editor);

            pxtblockly.upgradeTilemapsInWorkspace(this.editor, pxt.react.getTilemapProject());

            this.initLayout();
            this.editor.clearUndo();
            this.reportDeprecatedBlocks();
            this.updateGrayBlocks();

            this.typeScriptSaveable = true;
        } catch (e) {
            pxt.log(e);
            pxt.blocks.clearWithoutEvents(this.editor);
            this.switchToTypeScript();
            this.changeCallback();
            return false;
        }

        this.changeCallback();

        return true;
    }

    private initLayout() {
        let needsLayout = false;
        let flyoutOnly = !this.editor.toolbox_ && (this.editor as any).flyout_;

        let minDistanceFromOrigin: number;
        let closestToOrigin: Blockly.utils.Rect;

        (this.editor.getTopComments(false) as Blockly.WorkspaceCommentSvg[]).forEach(b => {
            const bounds = b.getBoundingRectangle();

            const distanceFromOrigin = Math.sqrt(bounds.left * bounds.left + bounds.top * bounds.top);

            if (minDistanceFromOrigin === undefined || distanceFromOrigin < minDistanceFromOrigin) {
                closestToOrigin = bounds;
                minDistanceFromOrigin = distanceFromOrigin;
            }

            needsLayout = needsLayout || (bounds.left == 10 && bounds.top == 10);
        });
        let blockPositions: { left: number, top: number }[] = [];
        (this.editor.getTopBlocks(false) as Blockly.BlockSvg[]).forEach(b => {
            const bounds = b.getBoundingRectangle()

            const distanceFromOrigin = Math.sqrt(bounds.left * bounds.left + bounds.top * bounds.top);

            if (minDistanceFromOrigin === undefined || distanceFromOrigin < minDistanceFromOrigin) {
                closestToOrigin = bounds;
                minDistanceFromOrigin = distanceFromOrigin;
            }

            const isOverlapping = !!blockPositions.find(b => b.left === bounds.left && b.top === bounds.top)
            needsLayout = needsLayout || isOverlapping;

            blockPositions.push(bounds)
        });

        if (needsLayout && !flyoutOnly) {
            // If the blocks file has no location info (e.g. it's from the decompiler), format the code.
            pxt.blocks.layout.flow(this.editor, { useViewWidth: true });
        }
        else {
            if (closestToOrigin) {
                // Otherwise translate the blocks so that they are positioned on the top left
                this.editor.getTopComments(false).forEach(c => c.moveBy(-closestToOrigin.left, -closestToOrigin.top));
                this.editor.getTopBlocks(false).forEach(b => b.moveBy(-closestToOrigin.left, -closestToOrigin.top));
            }
            this.editor.scrollX = 10;
            this.editor.scrollY = 10;

            // Forces scroll to take effect
            this.editor.resizeContents();
        }
    }

    private initPrompts() {
        // Overriding blockly prompts to use semantic modals

        /**
         * Wrapper to window.alert() that app developers may override to
         * provide alternatives to the modal browser window.
         * @param {string} message The message to display to the user.
         * @param {function()=} opt_callback The callback when the alert is dismissed.
         */
        Blockly.alert = function (message, opt_callback) {
            return core.confirmAsync({
                hideCancel: true,
                header: lf("Alert"),
                agreeLbl: lf("Ok"),
                agreeClass: "positive",
                agreeIcon: "checkmark",
                body: message,
                size: "tiny"
            }).then(() => {
                if (opt_callback) {
                    opt_callback();
                }
            })
        };

        /**
         * Wrapper to window.confirm() that app developers may override to
         * provide alternatives to the modal browser window.
         * @param {string} message The message to display to the user.
         * @param {!function(boolean)} callback The callback for handling user response.
         */
        Blockly.confirm = function (message, callback) {
            return core.confirmAsync({
                header: lf("Confirm"),
                body: message,
                agreeLbl: lf("Yes"),
                agreeClass: "positive",
                agreeIcon: "checkmark",
                disagreeLbl: lf("No"),
                disagreeClass: "cancel",
                disagreeIcon: "cancel",
                size: "tiny"
            }).then(b => {
                callback(b == 1);
            })
        };

        /**
         * Wrapper to window.prompt() that app developers may override to provide
         * alternatives to the modal browser window. Built-in browser prompts are
         * often used for better text input experience on mobile device. We strongly
         * recommend testing mobile when overriding this.
         * @param {string} message The message to display to the user.
         * @param {string} defaultValue The value to initialize the prompt with.
         * @param {!function(string)} callback The callback for handling user reponse.
         * @param {Object} options
         */
        Blockly.prompt = function (message, defaultValue, callback, options) {
            return core.promptAsync({
                header: message,
                initialValue: defaultValue,
                agreeLbl: lf("Ok"),
                hasCloseIcon: true,
                size: "tiny",
                ...options
            }).then(value => {
                callback(value);
            })
        };

        if (pxt.Util.isTranslationMode())
            pxt.blocks.promptTranslateBlock = dialogs.promptTranslateBlock;
    }

    private initBlocklyToolbox() {
        let editor = this;
        /**
         * Move the toolbox to the edge.
         */
        const oldToolboxPosition = (Blockly as any).Toolbox.prototype.position;
        (Blockly as any).Toolbox.prototype.position = function () {
            oldToolboxPosition.call(this);
            editor.resizeToolbox();
        }

        /**
         * Override blockly methods to support our custom toolbox.
         */
        const that = this;
        (Blockly.WorkspaceSvg as any).prototype.refreshToolboxSelection = function () {
            let ws = this.isFlyout ? this.targetWorkspace : this;
            if (ws && !ws.currentGesture_ && ws.toolbox_ && ws.toolbox_.flyout_) {
                that.toolbox.refreshSelection();
            }
        };
        const oldHideChaff = (Blockly as any).hideChaff;
        (Blockly as any).hideChaff = function (opt_allowToolbox?: boolean) {
            oldHideChaff(opt_allowToolbox);
            if (!opt_allowToolbox) that.hideFlyout();
        };
    }

    private initWorkspaceSounds() {
        const editor = this;

        const oldAudioPlay = (Blockly as any).WorkspaceAudio.prototype.play;
        (Blockly as any).WorkspaceAudio.prototype.play = function (name: string, opt_volume?: number) {
            if (editor && editor.parent.state.mute) opt_volume = 0;
            oldAudioPlay.call(this, name, opt_volume);
        };
    }

    private initAccessibleBlocks() {
        const enabled = pxt.appTarget.appTheme?.accessibleBlocks;
        // Append listener to open toolbox on 'T' key if accessible blocks is enabled
        if (enabled) {
            document.querySelector("#blocksEditor").addEventListener("keydown", this.handleKeyDown)
        }

        const self = this;
        const onBlocklyAction = Blockly.navigation.onBlocklyAction;
        Blockly.navigation.onBlocklyAction = function (action) {
            if (pxt.appTarget.appTheme?.accessibleBlocks) {
                if (!self.editor.keyboardAccessibilityMode &&
                    (action as any).name === Blockly.navigation.actionNames.TOGGLE_KEYBOARD_NAV) {
                    self.parent.setState({ accessibleBlocks: true });
                }
                return onBlocklyAction(action);
            }
            return false;
        };
    }

    private reportDeprecatedBlocks() {
        const deprecatedMap: pxt.Map<number> = {};
        let deprecatedBlocksFound = false;

        this.blockInfo.blocks.forEach(symbolInfo => {
            if (symbolInfo.attributes.deprecated) {
                deprecatedMap[symbolInfo.attributes.blockId] = 0;
            }
        });

        this.editor.getAllBlocks().forEach(block => {
            if (deprecatedMap[block.type] >= 0) {
                deprecatedMap[block.type]++;
                deprecatedBlocksFound = true;
            }
        });

        for (const block in deprecatedMap) {
            if (deprecatedMap[block] !== 0) {
                pxt.tickEvent("blocks.usingDeprecated", { block: block, count: deprecatedMap[block] });
            }
        }
    }

    public contentSize(): { height: number; width: number } {
        return this.editor ? pxt.blocks.blocksMetrics(this.editor) : undefined;
    }

    private markIncomplete = false;
    isIncomplete() {
        const incomplete = this.editor && ((this.editor as any).currentGesture_ && (this.editor as any).currentGesture_.isDraggingBlock_);
        if (incomplete) this.markIncomplete = true;
        return incomplete;
    }

    prepare() {
        this.isReady = true
    }

    private prepareBlockly(forceHasCategories?: boolean) {
        pxt.perf.measureStart("prepareBlockly")
        let blocklyDiv = document.getElementById('blocksEditor');
        if (!blocklyDiv)
            return;
        pxsim.U.clear(blocklyDiv);
        this.editor = Blockly.inject(blocklyDiv, this.getBlocklyOptions(forceHasCategories)) as Blockly.WorkspaceSvg;
        const hasCategories = (this.editor.options as any).hasCategories;
        // set Blockly Colors
        let blocklyColors = (Blockly as any).Colours;
        Util.jsonMergeFrom(blocklyColors, pxt.appTarget.appTheme.blocklyColors || {});
        (Blockly as any).Colours = blocklyColors;

        let shouldRestartSim = false;

        this.editor.addChangeListener((ev: any) => {
            Blockly.Events.disableOrphans(ev);
            if (ev.type != 'ui' || this.markIncomplete) {
                this.changeCallback();
                this.markIncomplete = false;
            }
            if (ev.type == 'create') {
                let blockId = ev.xml.getAttribute('type');
                if (blockId == "variables_set") {
                    // Need to bump suffix in flyout
                    this.clearFlyoutCaches();
                }
                if (blockId === pxtc.TS_STATEMENT_TYPE || blockId === pxtc.TS_OUTPUT_TYPE) {
                    this.updateGrayBlocks();
                }
                pxt.tickEvent("blocks.create", { "block": blockId }, { interactiveConsent: true });
                if (ev.xml.tagName == 'SHADOW')
                    this.cleanUpShadowBlocks();
                if (!this.parent.state.tutorialOptions || !this.parent.state.tutorialOptions.metadata || !this.parent.state.tutorialOptions.metadata.flyoutOnly)
                    this.parent.setState({ hideEditorFloats: false });
                workspace.fireEvent({ type: 'create', editor: 'blocks', blockId } as pxt.editor.events.CreateEvent);
            }
            else if (ev.type == "var_create" || ev.type == "var_rename" || ev.type == "delete") {
                // a new variable name is used or blocks were removed,
                // clear the toolbox caches as some blocks may need to be recomputed
                this.clearFlyoutCaches();
            }
            else if (ev.type == 'ui') {
                if (ev.element == 'category') {
                    let toolboxVisible = !!ev.newValue;
                    if (toolboxVisible) pxt.setInteractiveConsent(true);
                    this.parent.setState({ hideEditorFloats: toolboxVisible });
                } else if (ev.element == 'breakpointSet') {
                    this.setBreakpointsFromBlocks();
                    // if (ev.newValue) {
                    //     this.addBreakpointFromEvent(ev.blockId);
                    // } else {
                    //     this.removeBreakpointFromEvent(ev.blockId);
                    // }
                }
                else if (ev.element == 'melody-editor') {
                    if (ev.newValue) {
                        shouldRestartSim = this.parent.state.simState != pxt.editor.SimState.Stopped;
                        this.parent.stopSimulator();
                    }
                    else {
                        if (shouldRestartSim) {
                            this.parent.startSimulator();
                        }
                    }
                }
            }

            // reset tutorial hint animation on any blockly event
            if (this.parent.state.tutorialOptions != undefined) {
                this.parent.pokeUserActivity();
            }
        })
        if (this.shouldShowCategories()) {
            this.renderToolbox();
        }
        this.hideFlyout();
        this.initPrompts();
        this.initBlocklyToolbox();
        this.initWorkspaceSounds();
        this.initAccessibleBlocks();
        this.resize();

        pxt.perf.measureEnd("prepareBlockly")
    }

    resize(e?: Event) {
        const blocklyArea = this.getBlocksAreaDiv();
        if (!blocklyArea) return;

        const blocklyDiv = this.getBlocksEditorDiv();
        // Position blocklyDiv over blocklyArea.
        if (blocklyDiv && this.editor) {
            Blockly.svgResize(this.editor);
            this.resizeToolbox();
            this.resizeFieldEditorView();
        }
    }

    resizeToolbox() {
        const blocklyDiv = this.getBlocksEditorDiv();
        if (!blocklyDiv) return;

        const blocklyToolboxDiv = this.getBlocklyToolboxDiv();
        if (!blocklyToolboxDiv) return;
        if (this.parent.isBlocksActive()) this.parent.updateEditorLogo(blocklyToolboxDiv.offsetWidth);

        const blocklyOptions = this.getBlocklyOptions(this.showCategories);
        if (!(blocklyOptions as any).horizontalLayout) blocklyToolboxDiv.style.height = `100%`;
    }

    protected resizeFieldEditorView() {
        if (!window) return;
        // Full-screen editor
        blocklyFieldView.setEditorBounds({
            top: 0,
            left: 0,
            width: window.innerWidth,
            height: window.innerHeight
        });
    }

    hasUndo() {
        // undo is true if undoStack has items, or if both undo and redo are empty (first project load)
        return this.editor ? this.editor.undoStack_.length != 0
            || (this.editor.undoStack_.length == 0 && this.editor.redoStack_.length == 0) : false;
    }

    undo() {
        if (!this.editor) return;
        this.editor.undo(false);
        Blockly.hideChaff();
        this.parent.forceUpdate();
    }

    hasRedo() {
        return this.editor ? this.editor.redoStack_.length != 0 : false;
    }

    redo() {
        if (!this.editor) return;
        this.editor.undo(true);
        Blockly.hideChaff();
        this.parent.forceUpdate();
    }

    zoomIn() {
        if (!this.editor) return;
        this.editor.zoomCenter(0.8);
    }

    zoomOut() {
        if (!this.editor) return;
        this.editor.zoomCenter(-0.8);
    }

    setScale(scale: number) {
        if (!this.editor) return;
        if (scale != this.editor.scale) {
            this.editor.setScale(scale);
        }
    }

    closeFlyout() {
        if (!this.editor) return;
        this.hideFlyout();
    }

    getId() {
        return "blocksArea"
    }

    display(): JSX.Element {
        let flyoutOnly = this.parent.state.editorState && this.parent.state.editorState.hasCategories === false;
        let showErrorList = pxt.appTarget.appTheme.blocksErrorList;
        return (
            <div className="blocksAndErrorList">
                <div className="blocksEditorOuter">
                    <div id="blocksEditor"></div>
                    <toolbox.ToolboxTrashIcon flyoutOnly={flyoutOnly} />
                </div>
                {showErrorList && <ErrorList isInBlocksEditor={true} listenToBlockErrorChanges={this.listenToBlockErrorChanges}
                    onSizeChange={this.onErrorListResize} />}
            </div>
        )
    }

    onErrorListResize() {
        this.parent.fireResize();
    }

    listenToBlockErrorChanges(handlerKey: string, handler: (errors: pxt.blocks.BlockDiagnostic[]) => void) {
        this.errorChangesListeners[handlerKey] = handler;
    }

    private onBlockErrorChanges(errors: pxt.blocks.BlockDiagnostic[]) {
        for (let listener of pxt.U.values(this.errorChangesListeners)) {
            listener(errors)
        }
    }

    async validateTutorialCode(tutorial: pxt.tutorial.TutorialOptions) {
        // Current tutorial step
        const { tutorialStep } = tutorial;
        const blocks = this.editor.getAllBlocks();
        const tutorialCodeStatus = await pxt.tutorial.validate(tutorial, blocks, this.blockInfo);
        this.parent.setTutorialCodeStatus(tutorialStep, tutorialCodeStatus);
    }

    getBlocksAreaDiv() {
        return document.getElementById('blocksArea');
    }

    getBlocksEditorDiv() {
        const blocksArea = this.getBlocksAreaDiv();
        return blocksArea ? document.getElementById('blocksEditor') : undefined;
    }

    getBlocklyToolboxDiv(): HTMLDivElement {
        const blocksArea = this.getBlocksAreaDiv();
        return blocksArea ? blocksArea.getElementsByClassName('blocklyToolboxDiv')[0] as HTMLDivElement : undefined;
    }

    handleToolboxRef = (c: toolbox.Toolbox) => {
        this.toolbox = c;
    }

    handleDebuggerToolboxRef = (c: DebuggerToolbox) => {
        this.debuggerToolbox = c;
    }

    public moveFocusToFlyout() {
        const flyout = this.editor.toolbox_.getFlyout();
        if (flyout && this.parent.state?.accessibleBlocks) {
            (Blockly.navigation as any).focusFlyout_();
            flyout.svgGroup_.focus();
        }
    }

    focusToolbox() {
        if (this.toolbox) {
            this.toolbox.focus();
        }
    }

    renderToolbox(immediate?: boolean) {
        if (pxt.shell.isReadOnly()) return;
        const blocklyToolboxDiv = this.getBlocklyToolboxDiv();
        const blocklyToolbox = <div className="blocklyToolbox">
            <toolbox.Toolbox ref={this.handleToolboxRef} editorname="blocks" parent={this} />
            {<div id="debuggerToolbox"></div>}
        </div>;
        Util.assert(!!blocklyToolboxDiv);
        ReactDOM.render(blocklyToolbox, blocklyToolboxDiv);

        if (!immediate) this.toolbox.showLoading();
    }

    updateToolbox() {
        const container = document.getElementById('debuggerToolbox');
        if (!container) return;

        pxt.perf.measureStart("updateToolbox")
        const debugging = !!this.parent.state.debugging;
        let debuggerToolbox = debugging ? <DebuggerToolbox ref={this.handleDebuggerToolboxRef} parent={this.parent} apis={this.blockInfo.apis.byQName} /> : <div />;

        if (debugging) {
            this.toolbox.hide();
            // unselect any highlighted block
            (Blockly.selected as Blockly.BlockSvg)?.unselect();
        } else {
            this.debuggerToolbox = null;
            this.toolbox.show();
        }
        ReactDOM.render(debuggerToolbox, container);
        pxt.perf.measureEnd("updateToolbox")
    }

    showPackageDialog() {
        pxt.tickEvent("blocks.addpackage");
        if (this.editor.toolbox_) this.editor.toolbox_.clearSelection();
        this.parent.showPackageDialog();
    }

    showVariablesFlyout() {
        this.showFlyoutInternal_(Blockly.Variables.flyoutCategory(this.editor), "variables");
    }

    showFunctionsFlyout() {
        this.showFlyoutInternal_(Blockly.Functions.flyoutCategory(this.editor), "functions");
    }

    getViewState() {
        // ZOOM etc
        return {}
    }

    setViewState(pos: {}) { }

    getCurrentSource() {
        return this.editor && !this.delayLoadXml ? this.saveBlockly() : this.currSource;
    }

    acceptsFile(file: pkg.File) {
        return file.getExtension() == "blocks"
    }

    overrideFile(content: string) {
        if (this.delayLoadXml) {
            this.delayLoadXml = content;
            this.currSource = content;
        } else {
            this.loadBlockly(content);
        }
    }

    // TODO: remove this, we won't use it anymore
    insertBreakpoint() {
        if (!this.editor) return;
        const b = this.editor.newBlock(pxtc.TS_DEBUGGER_TYPE) as Blockly.BlockSvg;
        // move block roughly to the center of the screen
        const m = this.editor.getMetrics() as Blockly.Metrics;
        b.moveBy(m.viewWidth / 2, m.viewHeight / 3);
        b.initSvg();
        b.render();
    }

    private _loadBlocklyPromise: Promise<void>;
    loadBlocklyAsync() {
        if (!this._loadBlocklyPromise) {
            pxt.perf.measureStart("loadBlockly")
            this._loadBlocklyPromise = pxt.BrowserUtils.loadBlocklyAsync()
                .then(() => {
                    // Initialize the "Make a function" button
                    Blockly.Functions.editFunctionExternalHandler = (mutation: Element, cb: Blockly.Functions.ConfirmEditCallback) => {
                        Util.delay(10)
                            .then(() => {
                                if (!this.functionsDialog) {
                                    const wrapper = document.body.appendChild(document.createElement('div'));
                                    this.functionsDialog = ReactDOM.render(React.createElement(CreateFunctionDialog, { parent: this.parent }), wrapper) as CreateFunctionDialog;
                                }
                                this.functionsDialog.show(mutation, cb, this.editor);
                            });
                    }

                    pxt.blocks.openHelpUrl = (url: string) => {
                        pxt.tickEvent("blocks.help", { url }, { interactiveConsent: true });
                        const m = /^\/pkg\/([^#]+)#(.+)$/.exec(url);
                        if (m) {
                            const dep = pkg.mainPkg.deps[m[1]];
                            if (dep && dep.verProtocol() == "github") {
                                // rewrite url to point to current endpoint
                                url = `/pkg/${dep.verArgument().replace(/#.*$/, '')}#${m[2]}`;
                                window.open(url, m[1]);
                                return; // TODO support serving package docs in docs frame.
                            }
                        };
                        if (/^github:/.test(url)) {
                            // strip 'github:', add '.md' file extension if necessary
                            url = url.replace(/^github:\/?/, '') + (/\.md$/i.test(url) ? "" : ".md");
                            const readme = pkg.getEditorPkg(pkg.mainPkg).lookupFile(url);
                            const readmeContent = readme?.content?.trim();
                            if (readmeContent) {
                                this.parent.setSideMarkdown(readmeContent);
                                this.parent.setSideDocCollapsed(false);
                            }
                        } else if (/^\//.test(url)) {
                            this.parent.setSideDoc(url);
                        } else {
                            window.open(url, 'docs');
                        }
                    }
                    this.prepareBlockly();
                })
                .then(() => pxt.editor.initEditorExtensionsAsync())
                .then(() => pxt.perf.measureEnd("loadBlockly"))
        }
        return this._loadBlocklyPromise;
    }

    loadFileAsync(file: pkg.File): Promise<void> {
        Util.assert(!this.delayLoadXml);
        const init = this.loadingXmlPromise || Promise.resolve();

        return init
            .then(() => this.loadBlocklyAsync())
            .then(() => {
                pxt.blocks.cleanBlocks();

                if (this.toolbox) this.toolbox.showLoading();
                this.blockInfo = undefined;
                this.currSource = file.content;
                this.typeScriptSaveable = false;
                this.setDiagnostics(file)
                this.delayLoadXml = file.content;
                // serial editor is more like an overlay than a custom editor, so preserve blocks undo stack
                if (!this.parent.shouldPreserveUndoStack()) pxt.blocks.clearWithoutEvents(this.editor);
                this.closeFlyout();

                this.filterToolbox();
                if (this.parent.state.editorState && this.parent.state.editorState.hasCategories != undefined) {
                    this.showCategories = this.parent.state.editorState.hasCategories;
                } else {
                    this.showCategories = true;
                }
                this.currFile = file;
                // Clear the search field if a value exists
                let searchField = document.getElementById('blocklySearchInputField') as HTMLInputElement;
                if (searchField && searchField.value) {
                    searchField.value = '';
                }
                // Get extension packages
                this.extensions = (!!pxt.appTarget.appTheme.allowPackageExtensions
                    && pkg.allEditorPkgs()
                        .map(ep => ep.getKsPkg())
                        // Make sure the package has extensions enabled.
                        .filter(p => !!p?.config?.extension))
                    || [];
            })
    }

    unloadFileAsync(): Promise<void> {
        this.delayLoadXml = undefined;
        if (this.toolbox) this.toolbox.clearSearch();
        return Promise.resolve();
    }

    public switchToTypeScript() {
        pxt.tickEvent("blocks.switchjavascript");
        this.parent.closeFlyout();
        this.parent.switchTypeScript();
    }

    setDiagnostics(file: pkg.File) {
        Util.assert(this.editor != undefined); // Guarded
        if (!this.compilationResult || this.delayLoadXml || this.loadingXml)
            return;

        // clear previous warnings on non-disabled blocks
        this.editor.getAllBlocks().filter(b => b.isEnabled()).forEach((b: Blockly.BlockSvg) => {
            b.setWarningText(null);
            b.setHighlightWarning(false);
        });
        let tsfile = file && file.epkg && file.epkg.files[file.getVirtualFileName(pxt.JAVASCRIPT_PROJECT_NAME)];
        if (!tsfile || !tsfile.diagnostics) return;

        // only show errors
        let diags = tsfile.diagnostics.filter(d => d.category == ts.pxtc.DiagnosticCategory.Error);
        let sourceMap = this.compilationResult.sourceMap;

        diags.filter(diag => diag.category == ts.pxtc.DiagnosticCategory.Error).forEach(diag => {
            let bid = pxt.blocks.findBlockIdByLine(sourceMap, { start: diag.line, length: 0 });
            if (bid) {
                let b = this.editor.getBlockById(bid) as Blockly.BlockSvg;
                if (b) {
                    let txt = ts.pxtc.flattenDiagnosticMessageText(diag.messageText, "\n");
                    b.setWarningText(txt);
                    b.setHighlightWarning(true);
                }
            }
        })
        this.compilationResult.diagnostics.forEach(d => {
            if (d.blockId) {

                let b = this.editor.getBlockById(d.blockId) as Blockly.BlockSvg;

                if (b) {
                    b.setWarningText(d.message);
                    b.setHighlightWarning(true);
                }
            }
        })
        this.onBlockErrorChanges(this.compilationResult.diagnostics);
        this.setBreakpointsFromBlocks();
    }

    highlightStatement(stmt: pxtc.LocationInfo, brk?: pxsim.DebuggerBreakpointMessage): boolean {
        if (!this.compilationResult || this.delayLoadXml || this.loadingXml)
            return false;
        this.updateDebuggerVariables(brk);
        if (stmt) {
            let bid = pxt.blocks.findBlockIdByLine(this.compilationResult.sourceMap, { start: stmt.line, length: stmt.endLine - stmt.line });
            if (bid) {
                const parent = this.editor.getBlockById(bid).getRootBlock();
                bid = parent?.isCollapsed() ? parent.id : bid;
                this.editor.highlightBlock(bid);
                if (brk) {
                    const b = this.editor.getBlockById(bid) as Blockly.BlockSvg;
                    b.setWarningText(brk ? brk.exceptionMessage : undefined);
                    // ensure highlight is in the screen when a breakpoint info is available
                    // TODO: make warning mode look good
                    // b.setHighlightWarning(brk && !!brk.exceptionMessage);
                    const p = b.getRelativeToSurfaceXY();
                    const c = b.getHeightWidth();
                    const s = this.editor.scale;
                    const m = this.editor.getMetrics() as Blockly.Metrics;
                    // don't center if block is still on the screen
                    const marginx = 4;
                    const marginy = 4;
                    if (p.x * s < m.viewLeft + marginx
                        || (p.x + c.width) * s > m.viewLeft + m.viewWidth - marginx
                        || p.y * s < m.viewTop + marginy
                        || (p.y + c.height) * s > m.viewTop + m.viewHeight - marginy) {
                        // move the block towards the center
                        this.editor.centerOnBlock(bid);
                    }
                }
                return true;
            }
        } else {
            this.editor.highlightBlock(null);
            return false;
        }
        return false;
    }

    updateDebuggerVariables(brk: pxsim.DebuggerBreakpointMessage) {
        if (!this.parent.state.debugging) return;

        if (this.debuggerToolbox) {
            const visibleVars = Blockly.Variables.allUsedVarModels(this.editor)
                    .map((variable: Blockly.VariableModel) => variable.name);

            this.debuggerToolbox.setBreakpoint(brk, visibleVars);
        }
    }

    clearHighlightedStatements() {
        this.editor.highlightBlock(null);
        if (this.debuggerToolbox) this.debuggerToolbox.setBreakpoint(null);
    }

    openTypeScript() {
        pxt.tickEvent("blocks.showjavascript");
        this.parent.closeFlyout();
        this.parent.openTypeScriptAsync();
    }

    openPython() {
        pxt.tickEvent("blocks.showpython");
        this.parent.closeFlyout();
        this.parent.openPythonAsync();
    }

    private cleanUpShadowBlocks() {
        const blocks = this.editor.getTopBlocks(false);
        blocks.filter(b => b.isShadow()).forEach(b => b.dispose(false));
    }

    private getBlocklyOptions(forceHasCategories?: boolean) {
        let blocklyOptions = this.getDefaultOptions();
        Util.jsonMergeFrom(blocklyOptions, pxt.appTarget.appTheme.blocklyOptions || {});
        const hasCategories = (forceHasCategories != undefined) ? forceHasCategories :
            (blocklyOptions.hasCategories != undefined ? blocklyOptions.hasCategories :
                this.showCategories);
        blocklyOptions.hasCategories = hasCategories;
        blocklyOptions.renderer = "pxt";
        if (!hasCategories) this.showCategories = false;
        // If we're using categories, show the category toolbox, otherwise show the flyout toolbox
        const toolbox = hasCategories ?
            document.getElementById('blocklyToolboxDefinitionCategory')
            : document.getElementById('blocklyToolboxDefinitionFlyout');
        blocklyOptions['toolbox'] = blocklyOptions.toolbox != undefined ?
            blocklyOptions.toolbox : blocklyOptions.readOnly ? undefined : toolbox;
        return blocklyOptions;
    }

    private blocklyOptionsCache: Blockly.BlocklyOptions;
    private getDefaultOptions() {
        if (this.blocklyOptionsCache) return this.blocklyOptionsCache;
        const readOnly = pxt.shell.isReadOnly();
        const theme = pxt.appTarget.appTheme;
        const blocklyOptions: Blockly.BlocklyOptions = {
            media: pxt.webConfig.commitCdnUrl + "blockly/media/",
            sounds: true,
            trashcan: false,
            collapse: !!theme.blocksCollapsing,
            comments: true,
            disable: false,
            readOnly: readOnly,
            toolboxOptions: {
                colour: theme.coloredToolbox,
                inverted: theme.invertedToolbox
            },
            move: {
                scrollbars: true,
                wheel: true
            },
            zoom: {
                controls: false,
                maxScale: 2.5,
                minScale: .2,
                scaleSpeed: 1.5,
                startScale: pxt.BrowserUtils.isMobile() ? 0.7 : 0.9,
                pinch: true
            },
            rtl: Util.isUserLanguageRtl()
        };
        this.blocklyOptionsCache = blocklyOptions;
        return blocklyOptions;
    }

    private refreshToolbox() {
        if (!this.blockInfo) return;
        pxt.perf.measureStart("refreshToolbox")
        // no toolbox when readonly
        if (pxt.shell.isReadOnly()) return;

        // Dont show toolbox if we're in tutorial mode and we're not ready
        if (this.parent.state.tutorialOptions != undefined &&
            !this.parent.state.tutorialOptions.tutorialReady) {
            return;
        }

        this.clearCaches();

        const forceFlyoutOnly = this.parent.state.editorState && this.parent.state.editorState.hasCategories === false;
        const hasCategories = this.shouldShowCategories(!forceFlyoutOnly);

        // We might need to switch the toolbox type
        if ((this.editor.toolbox_ && hasCategories) || ((this.editor as any).flyout_ && !hasCategories)) {
            // Toolbox is consistent with current mode, safe to update
            if (hasCategories) {
                this.toolbox.setState({ loading: false, categories: this.getAllCategories(), showSearchBox: this.shouldShowSearch() });
            } else {
                this.showFlyoutOnlyToolbox();
            }
        } else {
            // Toolbox mode is different, need to refresh.
            if (!hasCategories) {
                // If we're switching from a toolbox to no toolbox, unmount node
                ReactDOM.unmountComponentAtNode(this.getBlocklyToolboxDiv());
            }

            const refreshBlockly = () => {
                this.delayLoadXml = this.getCurrentSource();
                this.editor = undefined;
                this.prepareBlockly(hasCategories);
                this.domUpdate();
                this.editor.scrollCenter();
                if (hasCategories) {
                    // If we're switching from no toolbox to a toolbox, mount node
                    this.renderToolbox(true);
                }
            };

            if (this.loadingXmlPromise) {
                // enqueue refresh if currently loading
                this.loadingXmlPromise
                    .then(refreshBlockly);
            } else {
                refreshBlockly();
            }
        }
        pxt.perf.measureEnd("refreshToolbox")
    }

    filterToolbox(showCategories?: boolean) {
        this.showCategories = showCategories;
        this.refreshToolbox();
    }

    private async openExtension(extensionName: string) {
        const pkg = this.extensions.filter(c => c.config.name === extensionName)[0];
        if (!pkg?.config.extension)
            return;
        pxt.tickEvent('blocks.extensions.open', { extension: extensionName })

        const { name, url, trusted } = await resolveExtensionUrl(pkg);

        // should never happen
        if (!trusted) {
            core.errorNotification(lf("Sorry, this extension is not allowed."))
            pxt.tickEvent('blocks.extensions.untrusted', { extension: extensionName })
            return;
        }

        pxt.tickEvent('blocks.extensions.trusted', { extension: extensionName })
        this.parent.openExtension(name, url);
    }

    private partitionBlocks() {
        const res: pxt.Map<toolbox.BlockDefinition[]> = {};
        this.topBlocks = [];

        const that = this;
        function setSubcategory(ns: string, subcat: string) {
            if (!that.subcategoryMap[ns]) that.subcategoryMap[ns] = {};
            that.subcategoryMap[ns][subcat] = true;
        }

        pxt.blocks.injectBlocks(this.blockInfo).forEach(fn => {
            let ns = (fn.attributes.blockNamespace || fn.namespace).split('.')[0];

            if (!res[ns]) {
                res[ns] = [];
            }
            res[ns].push(fn);

            const subcat = fn.attributes.subcategory;
            const advanced = fn.attributes.advanced;

            if (advanced) {
                // More subcategory
                setSubcategory(ns, lf("more"));
            } else if (subcat) {
                setSubcategory(ns, subcat);
            }

            if (fn.attributes.topblock) {
                this.topBlocks.push(fn);
            }
        });

        return res;
    }

    public hideFlyout() {
        if (this.editor.toolbox_) {
            this.editor.toolbox_.getFlyout().hide();
        }
        if (this.toolbox) this.toolbox.clear();
    }

    ///////////////////////////////////////////////////////////
    ////////////         Toolbox methods          /////////////
    ///////////////////////////////////////////////////////////

    clearCaches() {
        super.clearCaches();
        this.clearFlyoutCaches();
        snippets.clearBuiltinBlockCache();
        // note that we don't need to clear the flyout SVG cache since those
        // will regenerate themselves more precisely based on the hash of the
        // input blocks xml.
    }

    clearFlyoutCaches() {
        this.flyoutBlockXmlCache = {};
    }

    shouldShowSearch() {
        if (this.parent.state.editorState && this.parent.state.editorState.searchBar != undefined) {
            return this.parent.state.editorState.searchBar;
        }
        return true;
    }

    shouldShowCategories(forceHasCategories?: boolean) {
        if (this.parent.state.editorState && this.parent.state.editorState.hasCategories != undefined) {
            return this.parent.state.editorState.hasCategories;
        }
        const blocklyOptions = this.getBlocklyOptions(forceHasCategories);
        return blocklyOptions.hasCategories;
    }

    getBuiltinCategory(ns: string): toolbox.ToolboxCategory {
        return snippets.getBuiltinCategory(ns);
    }

    isBuiltIn(ns: string): boolean {
        return snippets.isBuiltin(ns);
    }

    getNamespaceAttrs(ns: string) {
        const builtin = snippets.getBuiltinCategory(ns);
        if (builtin) {
            builtin.attributes.color = pxt.toolbox.getNamespaceColor(builtin.nameid);
            return builtin.attributes;
        }
        if (!this.blockInfo) return undefined;

        return super.getNamespaceAttrs(ns);
    }

    getNamespaces() {
        const namespaces = Object.keys(this.nsMap)
            .filter(ns => !snippets.isBuiltin(ns) && !!this.getNamespaceAttrs(ns));

        function isRemoved(ns: string): boolean {
            return snippets.getBuiltinCategory(ns).removed;
        }

        let config = pxt.appTarget.runtime || {};
        if (config.loopsBlocks && !isRemoved(toolbox.CategoryNameID.Loops)) namespaces.push(toolbox.CategoryNameID.Loops);
        if (config.logicBlocks && !isRemoved(toolbox.CategoryNameID.Logic)) namespaces.push(toolbox.CategoryNameID.Logic);
        if (config.variablesBlocks && !isRemoved(toolbox.CategoryNameID.Variables)) namespaces.push(toolbox.CategoryNameID.Variables);
        if (config.mathBlocks && !isRemoved(toolbox.CategoryNameID.Maths)) namespaces.push(toolbox.CategoryNameID.Maths);
        if (config.functionBlocks && !isRemoved(toolbox.CategoryNameID.Functions)) namespaces.push(toolbox.CategoryNameID.Functions);
        if (config.listsBlocks && !isRemoved(toolbox.CategoryNameID.Arrays)) namespaces.push(toolbox.CategoryNameID.Arrays);
        if (config.textBlocks && !isRemoved(toolbox.CategoryNameID.Text)) namespaces.push(toolbox.CategoryNameID.Text);

        if (pxt.appTarget.cloud && pxt.appTarget.cloud.packages) {
            namespaces.push(toolbox.CategoryNameID.Extensions);
        }

        return namespaces.concat(super.getNamespaces());
    }

    ///////////////////////////////////////////////////////////
    ////////////         Flyout methods           /////////////
    ///////////////////////////////////////////////////////////

    public getBlocksForCategory(ns: string, subns?: string): (toolbox.BlockDefinition | toolbox.ButtonDefinition)[] {
        if (!snippets.isBuiltin(ns)) {
            return this.getNonBuiltInBlocks(ns, subns).concat(this.getExtraBlocks(ns, subns));
        } else {
            return this.getBuiltInBlocks(ns, subns).concat(this.getExtraBlocks(ns, subns));
        }
    }

    private filterBlocks(subns: string, blocks: toolbox.BlockDefinition[]) {
        return blocks.filter((block => !(block.attributes.blockHidden)
            && !(block.attributes.deprecated && !this.parent.isTutorial())
            && ((!subns && !block.attributes.subcategory && !block.attributes.advanced)
                || (subns && ((block.attributes.advanced && subns == lf("more"))
                    || (block.attributes.subcategory && subns == block.attributes.subcategory))))));
    }

    private getBuiltInBlocks(ns: string, subns: string) {
        let cat = snippets.getBuiltinCategory(ns);
        let blocks: toolbox.BlockDefinition[] = cat.blocks || [];
        if (!cat.custom && this.nsMap[ns]) {
            blocks = this.filterBlocks(subns, blocks.concat(this.nsMap[ns]));
        }
        return blocks;
    }

    private getNonBuiltInBlocks(ns: string, subns: string) {
        return this.filterBlocks(subns, this.nsMap[ns]) || [];
    }

    private getExtraBlocks(ns: string, subns: string) {
        if (subns) return [];
        let extraBlocks: (toolbox.BlockDefinition | toolbox.ButtonDefinition)[] = [];
        const onStartNamespace = pxt.appTarget.runtime.onStartNamespace || "loops";
        if (ns == onStartNamespace) {
            extraBlocks.push({
                name: ts.pxtc.ON_START_TYPE,
                attributes: {
                    blockId: ts.pxtc.ON_START_TYPE,
                    weight: pxt.appTarget.runtime.onStartWeight || 10
                },
                blockXml: `<block type="pxt-on-start"></block>`
            });
        }

        // Inject pause until block
        const pauseUntil = snippets.getPauseUntil();
        if (pauseUntil && ns == pauseUntil.attributes.blockNamespace) {
            extraBlocks.push(pauseUntil);
        }
        // Add extension buttons
        if (!subns) {
            this.extensions.forEach(extension => {
                const config = extension.config;
                const name = config.name;
                const namespace = config.extension.namespace || name;
                if (ns == namespace) {
                    extraBlocks.push({
                        name: `EXT${name}_BUTTON`,
                        type: "button",
                        attributes: {
                            blockId: `EXT${name}_BUTTON`,
                            label: config.extension.label ? Util.rlf(config.extension.label) : Util.lf("Editor"),
                            weight: 101,
                            group: config.extension.group
                        },
                        callback: () => {
                            this.openExtension(name);
                        }
                    });
                }
            })
        }

        if (pxt.appTarget.appTheme.snippetBuilder) {
            // Push snippet extension into extraBlocks
            initializeSnippetExtensions(ns, extraBlocks, this.editor, this.parent);
        }

        return extraBlocks;
    }

    private flyoutBlockXmlCache: pxt.Map<Element[]> = {};
    private flyoutXmlList: Element[] = [];
    public showFlyout(treeRow: toolbox.ToolboxCategory) {
        const { nameid: ns, subns } = treeRow;
        const inTutorial = this.parent.state.tutorialOptions
            && !!this.parent.state.tutorialOptions.tutorial;

        if (ns == 'search') {
            this.showSearchFlyout();
            return;
        }

        if (ns == 'topblocks') {
            this.showTopBlocksFlyout();
            return;
        }

        this.flyoutXmlList = [];
        let cacheKey = ns + subns + (inTutorial ? "tutorialexpanded" : "");
        if (this.flyoutBlockXmlCache[cacheKey]) {
            pxt.debug("showing flyout with blocks from flyout blocks xml cache");
            this.flyoutXmlList = this.flyoutBlockXmlCache[cacheKey];
            this.showFlyoutInternal_(this.flyoutXmlList, cacheKey);
            return;
        }

        if (this.abstractShowFlyout(treeRow)) {
            // Cache blocks xml list for later
            // don't cache when translating
            if (!pxt.Util.isTranslationMode())
                this.flyoutBlockXmlCache[cacheKey] = this.flyoutXmlList;

            this.showFlyoutInternal_(this.flyoutXmlList, cacheKey);
        }
    }

    protected showFlyoutHeadingLabel(ns: string, name: string, subns: string, icon: string, color: string) {
        const categoryName = name || Util.capitalize(subns || ns);
        const iconClass = `blocklyTreeIcon${icon ? ns.toLowerCase() : 'Default'}`.replace(/\s/g, '');
        let headingLabel = pxt.blocks.createFlyoutHeadingLabel(categoryName, color, icon, iconClass);
        this.flyoutXmlList.push(headingLabel);
    }

    protected showFlyoutGroupLabel(group: string, groupicon: string, labelLineWidth: string, helpCallback: string) {
        let groupLabel = pxt.blocks.createFlyoutGroupLabel(pxt.Util.rlf(`{id:group}${group}`),
            groupicon, labelLineWidth, helpCallback ? `GROUP_HELP_${group}` : undefined);
        if (helpCallback) {
            this.editor.registerButtonCallback(`GROUP_HELP_${group}`, (/*btn*/) => {
                this.helpButtonCallback(group);
            })
        }
        this.flyoutXmlList.push(groupLabel);
    }

    protected helpButtonCallback(group?: string) {
        pxt.debug(`${group} help icon clicked.`);
        workspace.fireEvent({ type: 'ui', editor: 'blocks', action: 'groupHelpClicked', data: { group } } as pxt.editor.events.UIEvent);
    }

    protected showFlyoutBlocks(ns: string, color: string, blocks: toolbox.BlockDefinition[]) {
        const filters = this.parent.state.editorState ? this.parent.state.editorState.filters : undefined;
        blocks.sort((f1, f2) => {
            // Sort the blocks
            return (f2.attributes.weight != undefined ? f2.attributes.weight : 50)
                - (f1.attributes.weight != undefined ? f1.attributes.weight : 50);
        }).forEach((block) => {
            let blockXmlList: Element[];
            if (block.type == "button") {
                blockXmlList = this.getButtonXml(block as toolbox.ButtonDefinition);
            } else {
                blockXmlList = this.getBlockXml(block as toolbox.BlockDefinition);
            }
            if (blockXmlList) this.flyoutXmlList = this.flyoutXmlList.concat(blockXmlList);
        })
    }

    private showSearchFlyout() {
        this.flyoutXmlList = [];
        const searchBlocks = this.toolbox.getSearchBlocks();

        searchBlocks.forEach((block) => {
            const blockXmlList = this.getBlockXml(block, true);
            if (blockXmlList) this.flyoutXmlList = this.flyoutXmlList.concat(blockXmlList);
        })

        if (this.flyoutXmlList.length == 0) {
            let label = Blockly.utils.xml.createElement('label');
            label.setAttribute('text', lf("No search results..."));
            this.flyoutXmlList.push(label);
        }
        this.showFlyoutInternal_(this.flyoutXmlList, "search");
        this.toolbox.setSearch();
    }

    private showTopBlocksFlyout() {
        this.flyoutXmlList = [];
        const topBlocks = this.getTopBlocks();
        if (topBlocks.length == 0) {
            let label = Blockly.utils.xml.createElement('label');
            label.setAttribute('text', lf("No basic blocks..."));
            this.flyoutXmlList.push(label);
        } else {
            // Show a heading
            this.showFlyoutHeadingLabel('topblocks', lf("{id:category}Basic"), null,
                pxt.toolbox.getNamespaceIcon('topblocks'), pxt.toolbox.getNamespaceColor('topblocks'));

            topBlocks.forEach((block) => {
                const blockXmlList = this.getBlockXml(block, true);
                if (blockXmlList) this.flyoutXmlList = this.flyoutXmlList.concat(blockXmlList);
            })
        }
        this.showFlyoutInternal_(this.flyoutXmlList);
    }

    private blocksToString(xmlList: Element[]): string {
        let xmlSerializer: XMLSerializer = null;
        const serialize = (e: Element) => {
            if (!e)
                return "<!-- invalid block here! -->"
            if (e.outerHTML)
                return e.outerHTML
            // The below code is only needed for IE 11 where outerHTML occassionally returns undefined :/
            if (!xmlSerializer)
                xmlSerializer = new XMLSerializer()
            return xmlSerializer.serializeToString(e);
        }
        return xmlList
            .map(serialize)
            .reduce((p, c) => p + c, "")
    }

    private hashBlocks(xmlList: Element[]): number {
        return pxt.Util.codalHash16(this.blocksToString(xmlList));
    }

    private swapFlyout(old: Blockly.VerticalFlyout, nw: Blockly.VerticalFlyout) {
        // hide the old flyout
        old.setVisible(false)

        // set the "current" flyout
        this.editor.toolbox_.setFlyout(nw);

        // show the new flyout
        nw.setVisible(true)

        // reflow if scale changed
        const flyoutWs = nw.workspace_ as Blockly.WorkspaceSvg;
        const targetWs = nw.targetWorkspace_ as Blockly.WorkspaceSvg;
        const scaleChange = flyoutWs.scale !== targetWs.scale;
        if (scaleChange) {
            nw.reflow();
        }
    }

    private flyouts: pxt.Map<{ flyout: Blockly.VerticalFlyout, blocksHash: number }> = {};
    private showFlyoutInternal_(xmlList: Element[], flyoutName: string = "default") {
        if ((!this.parent.state.editorState || this.parent.state.editorState.hasCategories !== false)
            && this.editor.toolbox_) {
            const oldFlyout = this.editor.toolbox_.getFlyout() as Blockly.VerticalFlyout;

            // determine if the cached flyout exists and isn't stale
            const hasCachedFlyout = flyoutName in this.flyouts
            const cachedBlocksHash = hasCachedFlyout ? this.flyouts[flyoutName].blocksHash : 0;
            const currentBlocksHash = this.hashBlocks(xmlList);
            const isFlyoutUpToDate = cachedBlocksHash === currentBlocksHash && !!cachedBlocksHash

            const mkFlyout = () => {
                const workspace = this.editor.toolbox_.workspace_ as Blockly.WorkspaceSvg
                const oldSvg = oldFlyout.svgGroup_;
                const flyout = Blockly.Functions.createFlyout(workspace, oldSvg)
                return flyout as Blockly.VerticalFlyout;
            }

            // get the flyout from the cache or make a new one
            let newFlyout: Blockly.VerticalFlyout;
            if (!hasCachedFlyout) {
                newFlyout = mkFlyout();
                this.flyouts[flyoutName] = { flyout: newFlyout, blocksHash: 0 };
            } else {
                newFlyout = this.flyouts[flyoutName].flyout;
            }

            // update the blocks hash
            this.flyouts[flyoutName].blocksHash = currentBlocksHash;

            // switch to the new flyout
            this.swapFlyout(oldFlyout, newFlyout);

            // if the flyout contents have changed, recreate the blocks
            if (!isFlyoutUpToDate) {
                newFlyout.show(xmlList);
            }

            newFlyout.scrollToStart();
            if (this.parent.state?.accessibleBlocks) newFlyout.svgGroup_.focus();
        } else if ((this.editor as any).flyout_) {
            (this.editor as any).flyout_.show(xmlList);
            (this.editor as any).flyout_.scrollToStart();
        }
    }

    // For editors that have no toolbox
    showFlyoutOnlyToolbox() {
        // Show a Flyout only with all the blocks
        const allCategories = this.getAllCategories();
        let allBlocks: toolbox.BlockDefinition[] = [];
        allCategories.forEach(category => {
            const blocks = category.blocks;
            allBlocks = allBlocks.concat(blocks);
            if (category.subcategories) category.subcategories.forEach(subcategory => {
                const subblocks = subcategory.blocks;
                allBlocks = allBlocks.concat(subblocks);
            })
        });

        let container = document.createElement("div");
        ReactDOM.render(<toolbox.ToolboxStyle categories={allCategories} />, container);
        document.getElementById('editorcontent').appendChild(container);

        let xmlList: Element[] = [];
        allBlocks.forEach((block) => {
            const blockXmlList = this.getBlockXml(block);
            if (blockXmlList) xmlList = xmlList.concat(blockXmlList);
        })
        this.showFlyoutInternal_(xmlList);
        this.parent.forceUpdate();
    }

    protected updateGrayBlocks() {
        if (this.editor) {
            const pythonEnabled = pxt.shell.isPyLangPref();
            this.editor.getAllBlocks(false).forEach(b => {
                if (b.type === pxtc.TS_STATEMENT_TYPE || b.type === pxtc.TS_OUTPUT_TYPE) {
                    (b as pxt.blocks.GrayBlock).setPythonEnabled(pythonEnabled);
                }
            })
        }
    }

    ///////////////////////////////////////////////////////////
    ////////////          Block methods           /////////////
    ///////////////////////////////////////////////////////////

    private getBlockXml(block: toolbox.BlockDefinition, ignoregap?: boolean, shadow?: boolean): Element[] {
        const that = this;
        let blockXml: Element;
        // Check if the block is built in, ignore it as it's already defined in snippets
        if (block.attributes.blockBuiltin) {
            pxt.log("ignoring built in block: " + block.attributes.blockId);
            return undefined;
        }
        if (block.builtinBlock) {
            // function_return is conditionally added to the toolbox, so it needs a special case
            if (block.attributes.blockId === "function_return") {
                return [pxt.blocks.mkReturnStatementBlock()];
            }
            // Find the block XML for this built in block.
            const builtin = snippets.allBuiltinBlocks()[block.attributes.blockId];
            if (builtin && builtin.blockXml && block.builtinField && block.builtinField.length == 2) {
                // Likley a built in block with a mutatation, check the fields.
                const field = block.builtinField[0];
                const value = block.builtinField[1];
                const regExp = new RegExp(`<field name="${field}">(.*)<\/field>`, 'i');
                builtin.blockXml = builtin.blockXml.replace(regExp, () => {
                    return `<field name="${field}">${value}<\/field>`;
                });
            }
            return builtin ? this.getBlockXml(builtin, ignoregap) : undefined;
        }
        if (!block.blockXml) {
            let fn = pxt.blocks.blockSymbol(block.attributes.blockId);
            if (fn) {
                if (!shouldShowBlock(fn)) return undefined;
                let comp = pxt.blocks.compileInfo(fn);
                blockXml = pxt.blocks.createToolboxBlock(this.blockInfo, fn, comp);

                if (fn.attributes.optionalVariableArgs && fn.attributes.toolboxVariableArgs) {
                    const handlerArgs = comp.handlerArgs;
                    const mutationValues = fn.attributes.toolboxVariableArgs.split(";")
                        .map(v => parseInt(v))
                        .filter(v => v <= handlerArgs.length && v >= 0);

                    mutationValues.forEach(v => {
                        const mutation = document.createElement("mutation");
                        mutation.setAttribute("numargs", v.toString());
                        for (let i = 0; i < v; i++) {
                            mutation.setAttribute("arg" + i, handlerArgs[i].name)
                        }
                        blockXml.appendChild(mutation);
                    });
                } else if (comp.handlerArgs.length && !fn.attributes.optionalVariableArgs) {
                    comp.handlerArgs.forEach(arg => {
                        const getterblock = Blockly.Xml.textToDom(`
    <value name="HANDLER_${arg.name}">
    <shadow type="variables_get_reporter">
    <field name="VAR" variabletype="">${arg.name}</field>
    </shadow>
    </value>`);
                        blockXml.appendChild(getterblock);
                    });
                } else if (fn.attributes.mutateDefaults) {
                    const mutationValues = fn.attributes.mutateDefaults.split(";");
                    const mutatedBlocks: Element[] = [];
                    mutationValues.forEach(mutation => {
                        const mutatedBlock = blockXml.cloneNode(true) as HTMLElement;
                        pxt.blocks.mutateToolboxBlock(mutatedBlock, fn.attributes.mutate, mutation);
                        mutatedBlocks.push(mutatedBlock);
                    });
                    return mutatedBlocks;
                } else if (fn.attributes.blockSetVariable != undefined && fn.retType && !shadow) {
                    // if requested, wrap block into a "set variable block"
                    const rawName = fn.attributes.blockSetVariable;

                    let varName: string;

                    // By default if the API author does not put any value for blockSetVariable
                    // then our comment parser will fill in the string "true". This gets caught
                    // by isReservedWord() so no need to do a separate check.
                    if (!rawName || pxt.blocks.isReservedWord(rawName)) {
                        varName = Util.htmlEscape(fn.retType.toLowerCase());
                    }
                    else {
                        varName = Util.htmlEscape(rawName);
                    }
                    // since we are creating variable, generate a new name that does not
                    // clash with existing variable names
                    let varNameUnique = varName;
                    let index = 2;
                    while (variableIsAssigned(varNameUnique, this.editor)) {
                        varNameUnique = varName + index++;
                    }
                    varName = varNameUnique;

                    const setblock = Blockly.Xml.textToDom(`
<block type="variables_set" gap="${Util.htmlEscape((fn.attributes.blockGap || 8) + "")}">
<field name="VAR" variabletype="">${varName}</field>
</block>`);
                    {
                        let value = document.createElement('value');
                        value.setAttribute('name', 'VALUE');
                        value.appendChild(blockXml);
                        value.appendChild(pxt.blocks.mkFieldBlock("math_number", "NUM", "0", true));
                        setblock.appendChild(value);
                    }
                    blockXml = setblock;
                }
            } else {
                pxt.log("Couldn't find block for: " + block.attributes.blockId);
                pxt.log(block);
            }
        } else {
            blockXml = Blockly.Xml.textToDom(block.blockXml);
        }
        if (blockXml) {
            if (ignoregap) {
                blockXml.setAttribute("gap", `${pxt.appTarget.appTheme
                    && pxt.appTarget.appTheme.defaultBlockGap && pxt.appTarget.appTheme.defaultBlockGap.toString() || 8}`);
            }
            pxt.Util.toArray(blockXml.querySelectorAll('shadow'))
                .filter(shadow => !shadow.innerHTML)
                .forEach((shadow, i) => {
                    let type = shadow.getAttribute('type');
                    const builtin = snippets.allBuiltinBlocks()[type];
                    let b = this.getBlockXml(builtin ? builtin : { name: type, attributes: { blockId: type } }, ignoregap, true);
                    // Note: we're setting one innerHTML to another
                    // eslint-disable-next-line @microsoft/sdl/no-inner-html
                    if (b && b.length > 0 && b[0]) shadow.innerHTML = b[0].innerHTML;
                })
        }
        return [blockXml];
        function shouldShowBlock(fn: pxtc.SymbolInfo) {
            if (fn.attributes.debug && !pxt.options.debug) return false;
            if (!shadow && fn.attributes.blockHidden) return false;
            if (fn.attributes.deprecated && !that.parent.isTutorial()) return false;
            let ns = (fn.attributes.blockNamespace || fn.namespace).split('.')[0];
            return that.shouldShowBlock(fn.attributes.blockId, ns, shadow);
        }

        function variableIsAssigned(name: string, editor: Blockly.WorkspaceSvg) {
            const varModel = editor.getVariable(name);
            const varUses = varModel && editor.getVariableUsesById(varModel.getId());
            return varUses && varUses.some(b => b.type == "variables_set" || b.type == "variables_change");
        }
    }

    private getButtonXml(button: toolbox.ButtonDefinition): Element[] {
        this.editor.registerButtonCallback(button.attributes.blockId, (btn) => {
            button.callback();
        })
        return [pxt.blocks.createFlyoutButton(button.attributes.blockId, button.attributes.label)];
    }

    updateBreakpoints() {
        if (!this.editor) return; // not loaded yet

        const debugging = !!this.parent.state.debugging;
        const blocks = this.editor.getAllBlocks();
        blocks.forEach(block => {
            if (block.previousConnection) {
                block.enableBreakpoint(debugging);
            }
        });
        this.editor.setDebugModeOption(debugging);
    }
}

function forEachImageField(workspace: Blockly.Workspace, cb: (asset: pxtblockly.FieldAssetEditor<any, any>) => void) {
    const blocks = workspace.getAllBlocks(false);

    for (const block of blocks) {
        for (const input of block.inputList) {
            for (const field of input.fieldRow) {
                // No need to check for tilemap editor because those are never temporary
                if (field instanceof pxtblockly.FieldSpriteEditor || field instanceof pxtblockly.FieldAnimationEditor) {
                    cb(field)
                }
            }
        }
    }
}

function disposeOfTemporaryAssets(workspace: Blockly.Workspace) {
    forEachImageField(workspace, field => field.disposeOfTemporaryAsset());
}

function clearTemporaryAssetBlockData(workspace: Blockly.Workspace) {
    forEachImageField(workspace, field => field.clearTemporaryAssetData());
}