/// <reference path="../../built/pxtlib.d.ts" />

import * as React from "react";
import * as auth from "./auth";
import * as data from "./data";
import * as sui from "./sui";

type ISettingsProps = pxt.editor.ISettingsProps;

export interface EditorAccessibilityMenuProps extends ISettingsProps {
    highContrast?: boolean;
}

// This Component overrides shouldComponentUpdate, be sure to update that if the state is updated
export interface EditorAccessibilityMenuState {
    highContrast?: boolean;
}

export class EditorAccessibilityMenu extends data.Component<EditorAccessibilityMenuProps, EditorAccessibilityMenuState> {

    constructor(props: EditorAccessibilityMenuProps) {
        super(props);
        this.state = {
        }

        this.openJavaScript = this.openJavaScript.bind(this);
        this.openPython = this.openPython.bind(this);
        this.showLanguagePicker = this.showLanguagePicker.bind(this);
        this.toggleHighContrast = this.toggleHighContrast.bind(this);
        this.goHome = this.goHome.bind(this);
    }

    openJavaScript() {
        pxt.tickEvent("accmenu.editor.openJS", undefined, { interactiveConsent: true });
        this.props.parent.openJavaScript();
    }

    openPython() {
        pxt.tickEvent("accmenu.editor.openPY", undefined, { interactiveConsent: true });
        this.props.parent.openPython();
    }

    showLanguagePicker() {
        pxt.tickEvent("accmenu.editor.importdialog", undefined, { interactiveConsent: true });
        this.props.parent.showLanguagePicker();
    }

    toggleHighContrast() {
        pxt.tickEvent("accmenu.editor.togglecontrast", undefined, { interactiveConsent: true });
        this.props.parent.toggleHighContrast();
    }

    goHome() {
        pxt.tickEvent("accmenu.editor.home", undefined, { interactiveConsent: true });
        this.props.parent.showExitAndSaveDialog();
    }

    UNSAFE_componentWillReceiveProps(nextProps: EditorAccessibilityMenuProps) {
        const newState: EditorAccessibilityMenuState = {};
        if (nextProps.highContrast != undefined) {
            newState.highContrast = nextProps.highContrast;
        }
        if (Object.keys(newState).length > 0) this.setState(newState)
    }

    shouldComponentUpdate(nextProps: EditorAccessibilityMenuProps, nextState: EditorAccessibilityMenuState, nextContext: any): boolean {
        return this.state.highContrast != nextState.highContrast;
    }

    renderCore() {
        let highContrast = this.getData<boolean>(pxt.auth.HIGHCONTRAST)
        const targetTheme = pxt.appTarget.appTheme;
        const hasHome = !pxt.shell.isControllerMode();

        return <div className="ui accessibleMenu borderless fixed menu" role="menubar">
            <sui.Item className={`${targetTheme.invertedMenu ? `inverted` : ''} menu`} role="menuitem" icon="xicon js" text={lf("Skip to JavaScript editor")} onClick={this.openJavaScript} />
            {targetTheme.python ? <sui.Item className={`${targetTheme.invertedMenu ? `inverted` : ''} menu`} role="menuitem" icon="xicon python" text={lf("Skip to Python editor")} onClick={this.openPython} /> : undefined}
            {targetTheme.selectLanguage ? <sui.Item className={`${targetTheme.invertedMenu ? `inverted` : ''} menu`} role="menuitem" icon="xicon globe" text={lf("Select Language")} onClick={this.showLanguagePicker} /> : undefined}
            {targetTheme.highContrast ? <sui.Item className={`${targetTheme.invertedMenu ? `inverted` : ''} menu`} role="menuitem" text={highContrast ? lf("High Contrast Off") : lf("High Contrast On")} onClick={this.toggleHighContrast} /> : undefined}
            {hasHome ? <sui.Item className={`${targetTheme.invertedMenu ? `inverted` : ''} menu`} role="menuitem" icon="home" text={lf("Go Home")} onClick={this.goHome} /> : undefined}
        </div>;
    }
}

export interface HomeAccessibilityMenuProps extends ISettingsProps {
    highContrast: boolean;
}

// This Component overrides shouldComponentUpdate, be sure to update that if the state is updated
export interface HomeAccessibilityMenuState {
    highContrast?: boolean;
}

export class HomeAccessibilityMenu extends data.Component<HomeAccessibilityMenuProps, HomeAccessibilityMenuState> {

    constructor(props: HomeAccessibilityMenuProps) {
        super(props);
        this.state = {
        }

        this.newProject = this.newProject.bind(this);
        this.importProjectDialog = this.importProjectDialog.bind(this);
        this.showLanguagePicker = this.showLanguagePicker.bind(this);
        this.toggleHighContrast = this.toggleHighContrast.bind(this);
    }

    newProject() {
        pxt.tickEvent("accmenu.home.new", undefined, { interactiveConsent: true });
        this.props.parent.newProject();
    }

    importProjectDialog() {
        pxt.tickEvent("accmenu.home.importdialog", undefined, { interactiveConsent: true });
        this.props.parent.importProjectDialog();
    }

    showLanguagePicker() {
        pxt.tickEvent("accmenu.home.langpicker");
        this.props.parent.showLanguagePicker();
    }

    toggleHighContrast() {
        pxt.tickEvent("accmenu.home.togglecontrast", undefined, { interactiveConsent: true });
        this.props.parent.toggleHighContrast();
    }

    UNSAFE_componentWillReceiveProps(nextProps: HomeAccessibilityMenuProps) {
        const newState: HomeAccessibilityMenuState = {};
        if (nextProps.highContrast != undefined) {
            newState.highContrast = nextProps.highContrast;
        }
        if (Object.keys(newState).length > 0) this.setState(newState)
    }

    shouldComponentUpdate(nextProps: HomeAccessibilityMenuProps, nextState: HomeAccessibilityMenuState, nextContext: any): boolean {
        return this.state.highContrast != nextState.highContrast;
    }

    renderCore() {
        const { highContrast } = this.state;
        const targetTheme = pxt.appTarget.appTheme;
        return <div className="ui accessibleMenu borderless fixed menu" role="menubar">
            <sui.Item className={`${targetTheme.invertedMenu ? `inverted` : ''} menu`} role="menuitem" icon="add circle" text={lf("New Project")} onClick={this.newProject} />
            <sui.Item className={`${targetTheme.invertedMenu ? `inverted` : ''} menu`} role="menuitem" icon="upload" text={lf("Import Project")} onClick={this.importProjectDialog} />
            {targetTheme.selectLanguage ? <sui.Item className={`${targetTheme.invertedMenu ? `inverted` : ''} menu`} role="menuitem" icon="xicon globe" text={lf("Select Language")} onClick={this.showLanguagePicker} /> : undefined}
            {targetTheme.highContrast ? <sui.Item className={`${targetTheme.invertedMenu ? `inverted` : ''} menu`} role="menuitem" text={highContrast ? lf("High Contrast Off") : lf("High Contrast On")} onClick={this.toggleHighContrast} /> : undefined}
        </div>;
    }
}