import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactModal from 'react-modal';
import * as ReactTooltip from 'react-tooltip';

import * as data from "./data";
import * as core from "./core";
import * as auth from "./auth";

export const appElement = document.getElementById('content');

export interface UiProps {
    icon?: string;
    iconClass?: string;
    text?: string;
    textClass?: string;
    children?: any;
    className?: string;
    role?: string;
    title?: string;
    ariaLabel?: string;
    ariaHidden?: boolean;
    tabIndex?: number;
    rightIcon?: boolean;
    inverted?: boolean;
}

export type SIZES = 'mini' | 'tiny' | 'small' | 'medium' | 'large' | 'big' | 'huge' | 'massive';

export interface SidebarProps extends UiProps {
    visible?: boolean;
}

export function cx(classes: string[]): string {
    return classes.filter((c) => !!c && c.trim() != '').join(' ');
}

function genericClassName(cls: string, props: UiProps, ignoreIcon: boolean = false): string {
    return `${cls} ${ignoreIcon ? '' : props.icon && props.text ? 'icon icon-and-text' : props.icon ? 'icon' : ""} ${props.inverted ? 'inverted' : ''} ${props.className || ""}`;
}

export function genericContent(props: UiProps) {
    let retVal = [
        props.icon ? (<Icon key='iconkey' icon={props.icon + (props.text ? " icon-and-text " : "") + (props.iconClass ? " " + props.iconClass : '')} />) : null,
        props.text ? (<span key='textkey' className={'ui text' + (props.textClass ? ' ' + props.textClass : '')}>{props.text}</span>) : null,
    ]
    if (props.icon && props.rightIcon) retVal = retVal.reverse();
    return retVal;
}

export function fireClickOnEnter(e: React.KeyboardEvent<HTMLElement>): void {
    const charCode = core.keyCodeFromEvent(e);
    if (charCode === core.ENTER_KEY || charCode === core.SPACE_KEY) {
        e.preventDefault();
        (e.currentTarget as HTMLElement).click();
    }
}

export class UIElement<T, S> extends data.Component<T, S> {
}

export class StatelessUIElement<T> extends data.PureComponent<T, {}> {
}

///////////////////////////////////////////////////////////
////////////           Dropdowns              /////////////
///////////////////////////////////////////////////////////

export interface DropdownProps extends UiProps {
    disabled?: boolean;
    tabIndex?: number;
    value?: string;
    title?: string;
    id?: string;
    onChange?: (v: string) => void;
    onClick?: () => boolean;    // Return 'true' to toggle open/close

    titleContent?: React.ReactNode;
    displayAbove?: boolean;
    displayRight?: boolean;
    displayLeft?: boolean;
    dataTooltip?: string;
}

export interface DropdownState {
    open?: boolean;
    focus?: boolean;
}

export class DropdownMenu extends UIElement<DropdownProps, DropdownState> {

    show() {
        this.setState({ open: true, focus: true });
    }

    hide() {
        this.setState({ open: false });
    }

    toggle() {
        if (this.state.open) {
            this.hide();
        } else {
            this.show();
        }
    }

    private focus(el: HTMLElement) {
        this.setActive(el);
        el.focus();
    }

    private blur(el: HTMLElement) {
        if (this.isActive(el)) {
            pxt.BrowserUtils.removeClass(el, "active");
        }
    }

    private setActive(el: HTMLElement) {
        if (!this.isActive(el)) {
            pxt.BrowserUtils.addClass(el, "active");
        }
    }

    private isActive(el: HTMLElement) {
        return el && pxt.BrowserUtils.containsClass(el, "active");
    }

    getChildren() {
        const menu = this.refs["menu"] as HTMLElement;
        const children = [];
        for (let i = 0; i < menu.childNodes.length; i++) {
            const child = menu.childNodes[i] as HTMLElement;
            // Remove separators
            if (pxt.BrowserUtils.containsClass(child, "divider")) continue;
            // Check if item is intended for mobile only views
            if (pxt.BrowserUtils.containsClass(child, "mobile") && !pxt.BrowserUtils.isMobile()) continue;
            children.push(child);
        }
        return children;
    }

    isChildFocused() {
        const menu = this.refs["menu"] as HTMLElement;
        return menu.contains(document.activeElement);
    }

    private navigateToNextElement = (e: KeyboardEvent, prev: HTMLElement, next: HTMLElement) => {
        const dropdown = this.refs["dropdown"] as HTMLElement;
        const charCode = core.keyCodeFromEvent(e);
        const current = e.currentTarget as HTMLElement;
        if (charCode === 40 /* Down arrow */) {
            e.preventDefault();
            e.stopPropagation();
            if (next) {
                this.focus(next);
            }
        } else if (charCode === 38 /* Up arrow */) {
            e.preventDefault();
            e.stopPropagation();
            if (prev) {
                this.focus(prev);
            } else {
                // Prev is undefined, go to dropdown
                dropdown.focus();
                this.setState({ open: false });
            }
        } else if (charCode === core.SPACE_KEY || charCode === core.ENTER_KEY) {
            // Trigger click
            e.preventDefault();
            e.stopPropagation();
            current.click();
        }
    }

    componentDidMount() {
        const children = this.getChildren();
        for (let i = 0; i < children.length; i++) {
            const prev = i > 0 ? children[i - 1] as HTMLElement : undefined;
            const child = children[i] as HTMLElement;
            const next = i < children.length ? children[i + 1] as HTMLElement : undefined;

            child.addEventListener('keydown', (e) => {
                this.navigateToNextElement(e, prev, next);
            })

            child.addEventListener('focus', (e: FocusEvent) => {
                this.setActive(child);
            })
            child.addEventListener('blur', (e: FocusEvent) => {
                this.blur(child);
            })

            if (i == children.length - 1) {
                // set tab on last child to clear focus
                child.addEventListener('keydown', (e) => {
                    const charCode = core.keyCodeFromEvent(e);
                    if (!e.shiftKey && charCode === core.TAB_KEY) {
                        this.hide();
                    }
                })
            }
        }
    }

    componentDidUpdate(prevProps: DropdownProps, prevState: DropdownState) {
        // Remove active from all menu items on any update
        const children = this.getChildren();
        for (let i = 0; i < children.length; i++) {
            const child = children[i] as HTMLElement;
            // On allow tabbing to valid child nodes (ie: no separators or mobile only items)
            child.tabIndex = this.state.open ? 0 : -1;
        }

        // Check if dropdown width exceeds the bounds, add the left class to the menu
        if (prevState.open != this.state.open && this.state.open) {
            const dropdown = this.refs["dropdown"] as HTMLElement;
            const menu = this.refs["menu"] as HTMLElement;
            if (dropdown.offsetLeft + menu.offsetWidth > window.innerWidth) {
                // Add left class to the menu
                pxt.BrowserUtils.addClass(menu, 'left');
            }
        }

        if (!prevState.focus && this.state.focus) {
            // Dropdown focused
        } else if (prevState.focus && !this.state.focus) {
            // Dropdown blurred
            if (!this.isMouseDown) {
                this.hide()
            }
        }

        if (!prevState.open && this.state.open) {
            // Dropdown opened
            document.addEventListener('keydown', this.closeOnEscape);
        } else if (prevState.open && !this.state.open) {
            // Dropdown closed
            document.removeEventListener('keydown', this.closeOnEscape);
            this.handleClose()
        }
        if (this.focusFirst && children.length > 0) {
            // Focus the first child
            this.focus(children[0]);
            this.focusFirst = false;
        }
    }

    private closeOnEscape = (e: KeyboardEvent) => {
        const charCode = core.keyCodeFromEvent(e);
        if (charCode === core.ESC_KEY) {
            e.preventDefault();
            const dropdown = this.refs["dropdown"] as HTMLElement;
            dropdown.focus();
            // Reset the focus handlers
            this.isMouseDown = true;
            this.hide();
        }
    }

    private handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!this.props.onClick || this.props.onClick())
            this.toggle();
        e.stopPropagation()
    }

    private handleClose = () => {
        this.isMouseDown = false
        const hasFocus = document.activeElement === this.refs['dropdown'];
        this.setState({ focus: hasFocus })
    }

    private isMouseDown: boolean;
    private handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        this.isMouseDown = true
        document.addEventListener(pxsim.pointerEvents.up, this.handleDocumentMouseUp)
    }

    private handleDocumentMouseUp = (e: MouseEvent) => {
        this.isMouseDown = false
        document.removeEventListener(pxsim.pointerEvents.up, this.handleDocumentMouseUp)
    }

    private handleFocus = (e: React.FocusEvent<HTMLDivElement>) => {
        const { focus } = this.state;
        if (focus) return;

        this.setState({ focus: true });
    }

    private handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
        if (this.isMouseDown) return;
        // Use timeout to delay examination of activeElement until after blur/focus
        // events have been processed.
        setTimeout(() => {
            let open = this.isChildFocused();
            this.setState({ focus: open });
        }, 1);
    }

    protected captureMouseEvent = (e: React.MouseEvent) => {
        e.stopPropagation();
    }

    private focusFirst: boolean;
    private handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const charCode = core.keyCodeFromEvent(e);
        if (charCode === 40 /* Down arrow key */) {
            e.preventDefault();
            this.focusFirst = true;
            this.show();
        } else if (charCode === core.SPACE_KEY || charCode === core.ENTER_KEY) {
            e.preventDefault();
            this.toggle();
        }
    }

    renderCore() {
        const { disabled, title, role, icon, className, titleContent, children,
            displayAbove, displayLeft, displayRight, dataTooltip } = this.props;
        const { open } = this.state;

        const aria = {
            'role': role || 'combobox',
            'aria-disabled': disabled,
            'aria-haspopup': !!disabled,
            'aria-expanded': open
        }
        const menuAria = {
            'role': 'menu',
            'aria-label': lf("Dropdown menu {0}", title),
            'aria-hidden': !!open
        }
        const classes = cx([
            'ui',
            open ? 'active visible' : '',
            'dropdown',
            icon ? 'icon' : '',
            className || '',
            displayAbove ? 'menuAbove' : '',
            displayRight ? 'menuRight' : '',
            displayLeft ? "menuLeft" : '',
        ]);
        const menuClasses = cx([
            'menu',
            open ? 'visible transition' : ''
        ])

        return (
            <div role="listbox" ref="dropdown" title={title} {...aria}
                id={this.props.id}
                className={classes}
                data-tooltip={dataTooltip}
                onMouseDown={this.handleMouseDown}
                onClick={this.handleClick}
                onKeyDown={this.handleKeyDown}
                onFocus={this.handleFocus}
                onBlur={this.handleBlur}
                tabIndex={0}
            >
                {titleContent ? titleContent : genericContent(this.props)}
                <div ref="menu" {...menuAria} className={menuClasses}
                    role="menu"
                    onMouseDown={this.captureMouseEvent}
                    onClick={this.captureMouseEvent}
                >
                    {children}
                </div>
            </div>);
    }
}

export interface ExpandableMenuProps {
    title?: string;
    onShow?: () => void;
    onHide?: () => void;
}

export interface ExpandableMenuState {
    expanded?: boolean;
}

export class ExpandableMenu extends UIElement<ExpandableMenuProps, ExpandableMenuState> {
    hide = () => {
        this.setState({ expanded: false });
        const { onHide } = this.props;
        if (onHide)
            onHide();
    }

    show = () => {
        this.setState({ expanded: true });
        const { onShow } = this.props;
        if (onShow)
            onShow();
    }

    toggleExpanded = () => {
        const { expanded } = this.state;

        if (expanded) {
            this.hide();
        } else {
            this.show();
        }
    }

    render() {
        const { title, children } = this.props;
        const { expanded } = this.state

        return (<div className="expandable-menu">
            <Link
                className="no-select menu-header"
                icon={`no-select chevron ${expanded ? "down" : "right"}`}
                text={title}
                ariaExpanded={expanded}
                onClick={this.toggleExpanded}
                role="button" />
            {expanded && <div className="expanded-items">
                {children}
            </div> }
        </div>);
    }
}

export interface SelectProps {
    options: SelectItem[];
    onChange?: (value: string) => void;
    "aria-label"?: string;
    label?: string;
}

export interface SelectState {
    selected?: string;
}

export interface SelectItem {
    value: string | number;
    display?: string;
}

export class Select extends UIElement<SelectProps, SelectState> {
    constructor(props: SelectProps) {
        super(props);
        const { options } = props;
        this.state = {
            selected: options[0] && (options[0].value + "")
        };
    }

    handleOnChange = (ev: React.ChangeEvent<HTMLSelectElement>) => {
        const { onChange } = this.props;
        this.setState({
            selected: ev.target.value
        });

        if (onChange) {
            onChange(ev.target.value);
        }
    }

    render() {
        const { options, label, "aria-label": ariaLabel } = this.props;
        const { selected } = this.state;

        return (<div>
            { label && `${label} ` }
            <select value={selected} className="ui dropdown" onChange={this.handleOnChange} aria-label={ariaLabel} >
                {options.map(opt =>
                    opt && <option
                        aria-selected={selected === opt.value}
                        value={opt.value}
                        key={opt.value}
                    >{opt.display || opt.value}</option>
                )}
            </select>
        </div>);
    }
}

///////////////////////////////////////////////////////////
////////////             Items                /////////////
///////////////////////////////////////////////////////////

export interface ItemProps extends UiProps {
    active?: boolean;
    value?: string;
    onClick?: () => void;
    onMouseDown?: (e: any) => void;
    onMouseUp?: (e: any) => void;
    onMouseLeave?: (e: any) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
}

export class Item extends data.Component<ItemProps, {}> {
    renderCore() {
        const {
            text,
            title,
            ariaLabel,
            ariaHidden
        } = this.props;

        return (
            <div className={genericClassName("ui item link", this.props, true) + ` ${this.props.active ? 'active' : ''}`}
                role={this.props.role}
                aria-label={ariaLabel || title || text}
                aria-selected={this.props.active}
                aria-hidden={ariaHidden}
                title={title || text}
                tabIndex={this.props.tabIndex || 0}
                key={this.props.value}
                data-value={this.props.value}
                onClick={this.props.onClick}
                onMouseDown={this.props.onMouseDown}
                onTouchStart={this.props.onMouseDown}
                onMouseUp={this.props.onMouseUp}
                onTouchEnd={this.props.onMouseUp}
                onMouseLeave={this.props.onMouseLeave}
                onKeyDown={this.props.onKeyDown || fireClickOnEnter}>
                {genericContent(this.props)}
                {this.props.children}
            </div>);
    }
}

export class ButtonMenuItem extends UIElement<ItemProps, {}> {
    renderCore() {
        return (
            <div className={genericClassName("ui item link", this.props, true) + ` ${this.props.active ? 'active' : ''}`}
                role={this.props.role}
                title={this.props.title || this.props.text}
                tabIndex={this.props.tabIndex || 0}
                key={this.props.value}
                data-value={this.props.value}
                onClick={this.props.onClick}
                onKeyDown={this.props.onKeyDown || fireClickOnEnter}>
                <div className={genericClassName("ui button", this.props)}>
                    {genericContent(this.props)}
                    {this.props.children}
                </div>
            </div>);
    }
}

///////////////////////////////////////////////////////////
////////////            Buttons               /////////////
///////////////////////////////////////////////////////////

export interface ButtonProps extends UiProps, TooltipUIProps {
    id?: string;
    title?: string;
    ariaLabel?: string;
    ariaExpanded?: boolean;
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    disabled?: boolean;
    loading?: boolean;
    onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
    labelPosition?: "left" | "right";
    color?: string;
    size?: SIZES;
    autoFocus?: boolean;
}

export class Button extends StatelessUIElement<ButtonProps> {
    renderCore() {
        const { labelPosition, color, size, disabled, loading } = this.props;
        const classes = cx([
            color,
            size,
            (disabled || loading) ? 'disabled' : '',
            loading ? 'loading' : '',
            genericClassName("ui button", this.props)
        ])
        const button = <button className={classes}
            id={this.props.id}
            role={this.props.role}
            title={this.props.title}
            tabIndex={this.props.tabIndex || 0}
            aria-label={this.props.ariaLabel}
            aria-expanded={this.props.ariaExpanded}
            onClick={this.props.onClick}
            onKeyDown={this.props.onKeyDown}
            autoFocus={this.props.autoFocus}
        >
            {genericContent(this.props)}
            {this.props.children}
        </button>;
        // Tooltips don't work great on IOS, disabling them
        return this.props.tooltipId && !pxt.BrowserUtils.isIOS() ? <Tooltip id={this.props.tooltipId} content={this.props.tooltip || this.props.title}
            place={this.props.tooltipPlace} delayShow={this.props.tooltipDelayShow}>{button}</Tooltip> : button;
    }
}


export interface CloseButtonProps extends UiProps, TooltipUIProps {
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
}
export class CloseButton extends StatelessUIElement<CloseButtonProps> {
    renderCore() {
        const { onClick } = this.props;
        return <div role="button" className="closeIcon" tabIndex={0}
            onClick={onClick}
            onKeyDown={fireClickOnEnter}
            aria-label={lf("Close")}
        >
            <Icon icon="close remove circle" />
        </div>
    }
}

///////////////////////////////////////////////////////////
////////////             Links                /////////////
///////////////////////////////////////////////////////////

export interface LinkProps extends ButtonProps {
    href?: string;
    download?: string;
    target?: string;
    rel?: string;
    refCallback?: React.Ref<HTMLAnchorElement>
}

export class Link extends StatelessUIElement<LinkProps> {
    renderCore() {
        return (
            <a className={genericClassName("ui", this.props)
                + (this.props.loading ? " loading" : "")
                + (this.props.disabled ? " disabled" : "")}
                id={this.props.id}
                href={this.props.href}
                target={this.props.target}
                rel={this.props.rel || (this.props.target ? "noopener noreferrer" : "")}
                download={this.props.download}
                ref={this.props.refCallback}
                role={this.props.role}
                title={this.props.title}
                tabIndex={this.props.tabIndex || 0}
                aria-label={this.props.ariaLabel}
                aria-expanded={this.props.ariaExpanded}
                onClick={this.props.onClick}
                onKeyDown={this.props.onKeyDown || fireClickOnEnter}
            >
                {genericContent(this.props)}
                {this.props.children}
            </a>
        );
    }
}

export function helpIconLink(url: string, title: string) {
    return <Link className="help-link" href={url} icon="help circle" target="_blank" role="link" title={title} />
}

///////////////////////////////////////////////////////////
////////////           FormField              /////////////
///////////////////////////////////////////////////////////

export class Field extends data.Component<{
    label?: string;
    children?: any;
    ariaLabel?: string;
    htmlFor?: string;
}, {}> {
    renderCore() {
        return (
            <div className="field">
                {this.props.label ? <label htmlFor={!this.props.ariaLabel ? this.props.htmlFor : undefined}>{this.props.label}</label> : null}
                {this.props.ariaLabel && this.props.htmlFor ? (<label htmlFor={this.props.htmlFor} className="accessible-hidden">{this.props.ariaLabel}</label>) : ""}
                {this.props.children}
            </div>
        );
    }
}

///////////////////////////////////////////////////////////
////////////             Input                /////////////
///////////////////////////////////////////////////////////

export interface InputProps {
    label?: string;
    inputLabel?: string;
    class?: string;
    value?: string;
    error?: string;
    type?: string;
    placeholder?: string;
    disabled?: boolean;
    onChange?: (v: string) => void;
    onEnter?: () => void;
    lines?: number;
    readOnly?: boolean;
    copy?: boolean;
    selectOnClick?: boolean;
    id?: string;
    ariaLabel?: string;
    autoFocus?: boolean;
    autoComplete?: boolean;
    selectOnMount?: boolean;
}

export interface InputState {
    value: string;
    copied?: boolean;
}

export class Input extends data.Component<InputProps, InputState> {
    constructor(props: InputProps) {
        super(props);
        this.state = {
            value: props.value
        }

        this.copy = this.copy.bind(this);
        this.handleClick = this.handleClick.bind(this);
        this.handleChange = this.handleChange.bind(this);
        this.handleEnterPressed = this.handleEnterPressed.bind(this);
    }

    componentDidMount() {
        const { selectOnMount, autoFocus } = this.props;
        if (selectOnMount && autoFocus) {
            const input = this.refs['inputField'] as HTMLInputElement;
            input.select();
        }
    }

    UNSAFE_componentWillReceiveProps(newProps: InputProps) {
        this.setState({ value: newProps.value });
    }

    clearValue() {
        this.setState({ value: undefined });
    }

    copy() {
        this.setState({ copied: false });
        const p = this.props
        const el = ReactDOM.findDOMNode(this);

        if (!p.lines || p.lines == 1) {
            const inp = el.getElementsByTagName("input")[0] as HTMLInputElement;
            inp.focus();
            inp.setSelectionRange(0, 9999);
        } else {
            const inp = el.getElementsByTagName("textarea")[0] as HTMLTextAreaElement;
            inp.focus();
            inp.setSelectionRange(0, 9999);
        }

        try {
            const success = document.execCommand("copy");
            pxt.debug('copy: ' + success);
            this.setState({ copied: !!success });
        } catch (e) {
            this.setState({ copied: false });
        }
    }

    handleClick(e: React.MouseEvent<any>) {
        if (this.props.selectOnClick) {
            (e.target as any).setSelectionRange(0, 9999);
        }
    }

    handleChange(e: React.ChangeEvent<any>) {
        const newValue = (e.target as any).value;
        if (!this.props.readOnly && (!this.state || this.state.value !== newValue)) {
            this.setState({ value: newValue, copied: false })
        }
        if (this.props.onChange) {
            this.props.onChange(newValue);
        }
    }

    handleEnterPressed(e: React.KeyboardEvent) {
        const charCode = core.keyCodeFromEvent(e);
        if (charCode === core.ENTER_KEY) {
            const { onEnter } = this.props;
            if (onEnter) {
                e.preventDefault();
                onEnter();
            }
        }
    }

    renderCore() {
        const p = this.props;
        const { copy, error, ariaLabel, id, label, inputLabel, lines, autoFocus, placeholder, readOnly, autoComplete } = p;
        const { value, copied } = this.state;
        const copyBtn = copy && document.queryCommandSupported('copy')
            ? <Button className={`ui right labeled ${copied ? "green" : "primary"} icon button`} text={copied ? lf("Copied!") : lf("Copy")} icon="copy" onClick={this.copy} />
            : null;

        return (
            <Field ariaLabel={ariaLabel} htmlFor={id} label={label}>
                <div className={"ui input" + (p.inputLabel ? " labelled" : "") + (copy ? " action fluid" : "") + (p.disabled ? " disabled" : "")}>
                    {inputLabel ? (<div className="ui label">{inputLabel}</div>) : ""}
                    {!lines || lines == 1 ? <input
                        ref='inputField'
                        autoFocus={autoFocus}
                        id={id}
                        className={p.class || ""}
                        type={p.type || "text"}
                        placeholder={placeholder} value={value || ''}
                        readOnly={!!readOnly}
                        onClick={this.handleClick}
                        onChange={this.handleChange}
                        onKeyDown={this.handleEnterPressed}
                        autoComplete={autoComplete ? "" : "off"}
                        autoCorrect={autoComplete ? "" : "off"}
                        autoCapitalize={autoComplete ? "" : "off"}
                        spellCheck={autoComplete}
                    />
                        : <textarea
                            id={id}
                            className={"ui input " + (p.class || "") + (inputLabel ? " labelled" : "")}
                            rows={lines}
                            placeholder={placeholder}
                            value={value || ''}
                            readOnly={!!readOnly}
                            onClick={this.handleClick}
                            onChange={this.handleChange}
                            onKeyDown={this.handleEnterPressed}>
                        </textarea>}
                    {copyBtn}
                </div>
                {error ? <div className="ui yellow message">{error}</div> : undefined}
            </Field>
        );
    }
}

///////////////////////////////////////////////////////////
////////////           Checkbox               /////////////
///////////////////////////////////////////////////////////

export interface CheckBoxProps {
    label?: string;
    inputLabel?: string;
    class?: string;
    checked?: boolean;
    onChange: (v: boolean) => void;
}

export class Checkbox extends data.Component<CheckBoxProps, {}> {
    constructor(props: CheckBoxProps) {
        super(props);
        this.state = {
        }

        this.handleChange = this.handleChange.bind(this);
    }

    handleChange(v: React.ChangeEvent<any>) {
        this.props.onChange(v.currentTarget.checked);
    }

    renderCore() {
        const p = this.props;
        return <Field label={p.label}>
            <div className={"ui toggle checkbox"}>
                <input type="checkbox" checked={p.checked} aria-checked={p.checked}
                    aria-label={p.label || p.inputLabel}
                    onChange={this.handleChange} />
                {p.inputLabel ? <label>{p.inputLabel}</label> : undefined}
            </div>
        </Field>;
    }
}

///////////////////////////////////////////////////////////
////////////             Icons                /////////////
///////////////////////////////////////////////////////////

export interface IconProps extends UiProps {
    icon?: string;
    onClick?: () => void;
    onKeyDown?: () => void;
}

export const Icon: React.StatelessComponent<IconProps> = (props: IconProps) => {
    const { icon, className, onClick, onKeyDown, children, ...rest } = props;
    return <i className={`icon ${icon} ${className ? className : ''}`}
        onClick={onClick}
        onKeyDown={onKeyDown || fireClickOnEnter}
        aria-hidden={true} role="presentation" {...rest}>
        {children}
    </i>
}

///////////////////////////////////////////////////////////
////////////             Menu                 /////////////
///////////////////////////////////////////////////////////

export interface MenuProps {
    activeIndex?: number;
    attached?: boolean | 'bottom' | 'top';
    borderless?: boolean;
    children?: React.ReactNode;
    className?: string;
    color?: string;
    compact?: boolean;
    defaultActiveIndex?: number;
    fixed?: 'left' | 'right' | 'bottom' | 'top';
    floated?: boolean | 'right';
    fluid?: boolean;
    icon?: boolean | 'labeled';
    inverted?: boolean;
    pagination?: boolean;
    pointing?: boolean;
    secondary?: boolean;
    size?: 'mini' | 'tiny' | 'small' | 'large' | 'huge' | 'massive';
    stackable?: boolean;
    tabular?: boolean | 'right';
    text?: boolean;
    vertical?: boolean;
}

export interface MenuItemProps {
    active?: boolean;
    children?: React.ReactNode;
    className?: string;
    color?: string;
    content?: React.ReactNode;
    fitted?: boolean | 'horizontally' | 'vertically';
    header?: boolean;
    icon?: any | boolean;
    index?: number;
    link?: boolean;
    name?: string;
    onClick?: (event: React.MouseEvent<HTMLElement>, data: MenuItemProps) => void;
    position?: 'right';
    ariaControls?: string;
    id?: string;
    tabIndex?: number;
    dataTooltip?: string;
}

export class MenuItem extends data.Component<MenuItemProps, {}> {
    constructor(props: MenuItemProps) {
        super(props);
    }

    handleClick = (e: React.MouseEvent<HTMLElement>) => {
        const { onClick } = this.props;
        if (onClick) onClick(e, this.props);
    }

    renderCore() {
        const {
            active,
            children,
            className,
            color,
            content,
            fitted,
            header,
            icon,
            link,
            name,
            onClick,
            position,
            ariaControls,
            id,
            tabIndex,
            dataTooltip
        } = this.props;

        const classes = cx([
            color,
            position,
            active ? 'active' : '',
            icon === true || icon && !(name || content) ? 'icon' : '',
            header ? 'header' : '',
            link || onClick ? 'link' : '',
            fitted ? (fitted == true ? `${fitted}` : `fitted ${fitted}`) : '',
            'item',
            className
        ]);

        if (children) {
            return <div role="menuitem" className={classes} onClick={this.handleClick}>{children}</div>
        }

        return (
            <div
                id={id}
                key={id}
                tabIndex={tabIndex != null ? tabIndex : -1}
                className={classes}
                onClick={this.handleClick}
                onKeyDown={fireClickOnEnter}
                role="tab"
                aria-controls={ariaControls}
                aria-selected={active}
                aria-label={`${content || name}`}
                data-tooltip={dataTooltip}
            >
                {icon ? <Icon icon={icon} /> : undefined}
                {content || name}
            </div>
        )
    }
}

export interface MenuState {
    activeIndex?: number;
}

export class Menu extends data.Component<MenuProps, MenuState> {
    constructor(props: MenuProps) {
        super(props);
    }

    private handleKeyboardNavigation = (e: KeyboardEvent) => {
        const charCode = core.keyCodeFromEvent(e);
        let leftOrUpKey = charCode === 37 || charCode === 38
        let rightorBottomKey = charCode === 39 || charCode === 40

        if (!leftOrUpKey && !rightorBottomKey) {
            return
        }

        let menuItems = this.child(".item");
        let activeNodeIndex = -1
        let i = 0

        while (activeNodeIndex === -1 && i < menuItems.length) {
            if (pxt.BrowserUtils.containsClass(menuItems[i] as HTMLElement, "active")) {
                activeNodeIndex = i
            }

            i++
        }

        if (activeNodeIndex === -1) {
            return
        }

        let selectedTab: HTMLElement;
        if ((leftOrUpKey && !pxt.Util.isUserLanguageRtl()) || (rightorBottomKey && pxt.Util.isUserLanguageRtl())) {
            if (activeNodeIndex === 0) {
                selectedTab = menuItems[menuItems.length - 1] as HTMLElement
            } else {
                selectedTab = menuItems[activeNodeIndex - 1] as HTMLElement
            }
        } else if ((rightorBottomKey && !pxt.Util.isUserLanguageRtl()) || (leftOrUpKey && pxt.Util.isUserLanguageRtl())) {
            if (activeNodeIndex === menuItems.length - 1) {
                selectedTab = menuItems[0] as HTMLElement
            } else {
                selectedTab = menuItems[activeNodeIndex + 1] as HTMLElement
            }
        }

        if (selectedTab !== undefined) {
            selectedTab.click()
            selectedTab.focus()
        }
    }

    componentDidMount() {
        let menuItems = this.child(".item");
        menuItems.forEach((elem: HTMLElement, index: number) => {
            elem.onkeydown = this.handleKeyboardNavigation
        })
    }

    renderCore() {
        const {
            attached,
            borderless,
            children,
            className,
            color,
            compact,
            fixed,
            floated,
            fluid,
            icon,
            inverted,
            pagination,
            pointing,
            secondary,
            size,
            stackable,
            tabular,
            text,
            vertical
        } = this.props;

        const classes = cx([
            'ui',
            color,
            size,
            borderless ? 'borderless' : '',
            compact ? 'compact' : '',
            fluid ? 'fluid' : '',
            inverted ? 'inverted' : '',
            pagination ? 'pagination' : '',
            pointing ? 'pointing' : '',
            secondary ? 'secondary' : '',
            stackable ? 'stackable' : '',
            text ? 'text' : '',
            vertical ? 'vertical' : '',
            attached ? (attached == true ? 'attached' : `${attached} attached `) : '',
            floated ? (floated == true ? 'floated' : `${floated} floated`) : '',
            icon ? (icon == true ? 'icon' : `${icon} icon`) : '',
            tabular ? (tabular == true ? 'tabular' : `${tabular} tabular`) : '',
            fixed ? `tabular ${tabular}` : '',
            className,
            'menu'
        ]);

        return (
            <div className={classes} role="tablist">
                {children}
            </div>
        )
    }
}

///////////////////////////////////////////////////////////
////////////             Modal                /////////////
///////////////////////////////////////////////////////////

export interface ModalButton {
    label?: string;
    title?: string;
    icon?: string; // defaults to "checkmark"
    className?: string; // defaults "positive"
    onclick?: () => (Promise<void> | void);
    resolveVal?: number;
    url?: string;
    urlButton?: boolean;
    fileName?: string;
    loading?: boolean;
    disabled?: boolean;
    approveButton?: boolean;
    labelPosition?: "left" | "right";
    ariaLabel?: string;
}

export interface ModalProps extends ReactModal.Props {
    closeOnDimmerClick?: boolean;
    closeOnDocumentClick?: boolean;
    closeOnEscape?: boolean;

    onClose?: () => void;
    onKeyDown?: (ev: React.KeyboardEvent<any>) => void;
    defaultOpen?: boolean;
    closeIcon?: boolean | string;

    size?: '' | 'fullscreen' | 'large' | 'mini' | 'small' | 'tiny';
    className?: string;
    basic?: boolean;
    longer?: boolean;

    header?: string;
    headerIcon?: string;
    headerClass?: string;
    description?: string;

    dimmer?: boolean | string;
    dimmerClassName?: string;

    helpUrl?: string;
    headerActions?: JSX.Element[];
    buttons?: ModalButton[];
    onPositionChanged?: Function;
    allowResetFocus?: boolean;
    modalDidOpen?: (ref: HTMLElement) => void;
    overlayClassName?: string;
}

interface ModalState {
    marginTop?: number;
    scrolling?: boolean;
    mountClasses?: string;
}

export class Modal extends data.Component<ModalProps, ModalState> {

    private id: string;
    private animationRequestId: any;

    constructor(props: ModalProps) {
        super(props);
        this.id = ts.pxtc.Util.guidGen();
        this.state = {
        }

        this.onRequestClose = this.onRequestClose.bind(this);
        this.afterOpen = this.afterOpen.bind(this);
    }

    private afterOpen() {
        const { modalDidOpen } = this.props;
        this.setState({ scrolling: false });
        this.setPositionAndClassNames();
        if (modalDidOpen) modalDidOpen(this.getRef());
    }

    private onClose() {
        cancelAnimationFrame(this.animationRequestId);
    }

    private getRef() {
        const modal = this.refs["modal"];
        const ref = modal && (modal as any).node
            && (modal as any).node.firstChild && (modal as any).node.firstChild.firstChild;
        return ref;
    }

    componentWillUnmount() {
        cancelAnimationFrame(this.animationRequestId);
    }

    setPositionAndClassNames = () => {
        const { dimmer } = this.props
        let classes;

        if (dimmer) {
            classes = 'dimmable dimmed';

            if (dimmer === 'blurring') {
                classes += ' blurring';
            }
        }

        const newState: ModalState = {}
        const ref = this.getRef();

        if (ref) {
            const { height } = ref.getBoundingClientRect();

            const marginTop = -Math.round(height / 2)
            const scrolling = height >= window.innerHeight;

            if (this.state.marginTop !== marginTop) {
                newState.marginTop = marginTop;
            }

            if (this.state.scrolling !== scrolling) {
                newState.scrolling = scrolling;
            }

            if (scrolling) classes += ' scrolling'
        }

        if (this.state.mountClasses !== classes) newState.mountClasses = classes;

        if (Object.keys(newState).length > 0) {
            this.setState(newState)
            if (this.props.onPositionChanged) this.props.onPositionChanged(this.props);
        }

        this.animationRequestId = requestAnimationFrame(this.setPositionAndClassNames);
    }

    private onRequestClose() {
        const { onClose } = this.props;
        this.onClose();
        onClose();
    }

    renderCore() {
        const { isOpen, size, longer, basic, className,
            onClose, closeIcon, children, onKeyDown,
            header, headerIcon, headerClass, headerActions, helpUrl, description,
            closeOnDimmerClick, closeOnDocumentClick, closeOnEscape,
            shouldCloseOnEsc, shouldCloseOnOverlayClick, shouldFocusAfterRender, overlayClassName, ...rest } = this.props;
        const { marginTop, scrolling, mountClasses } = this.state;
        const isFullscreen = size == 'fullscreen';
        const showBack = isFullscreen && !!closeIcon;

        const classes = cx([
            'ui',
            size,
            longer ? 'longer' : '',
            basic ? 'basic' : '',
            scrolling ? 'scrolling' : '',
            closeIcon ? 'closable' : '',
            'modal transition visible active',
            className
        ]);
        const hc = this.getData<boolean>(pxt.auth.HIGHCONTRAST);
        const portalClassName = cx([
            hc ? 'hc' : '',
            mountClasses
        ])
        const aria = {
            labelledby: header ? this.id + 'title' : undefined,
            describedby: (!isFullscreen && description) ? this.id + 'description' : this.id + 'desc'
        }
        const customStyles = {
            content: {
                marginTop: marginTop
            }
        }

        return <ReactModal isOpen={isOpen} ref="modal" appElement={appElement}
            onRequestClose={this.onRequestClose} onAfterOpen={this.afterOpen}
            shouldReturnFocusAfterClose={true} shouldFocusAfterRender={shouldFocusAfterRender}
            shouldCloseOnEsc={shouldCloseOnEsc || closeOnEscape}
            shouldCloseOnOverlayClick={shouldCloseOnOverlayClick || (closeOnDocumentClick || closeOnDimmerClick)}
            portalClassName={portalClassName}
            overlayClassName={`ui page modals dimmer transition ${overlayClassName} ${isOpen ? 'visible active' : ''}`}
            className={classes}
            style={customStyles}
            role="dialog"
            aria={aria} {...rest}>
            {header || showBack || helpUrl ? <div id={this.id + 'title'} className={"header " + (headerClass || "")}>
                {headerIcon && <Icon icon={headerIcon} />}
                <h3 className="header-title" style={{ margin: `0 ${helpUrl ? '-20rem' : '0'} 0 ${showBack ? '-20rem' : '0'}` }}>{header}</h3>
                {showBack ? <div className="header-close">
                    <Button className="back-button large" title={lf("Go back")} onClick={onClose} tabIndex={0} onKeyDown={fireClickOnEnter}>
                        <Icon icon="arrow left" />
                        <span className="ui text landscape only">{lf("Go back")}</span>
                    </Button>
                </div> : undefined}
                {helpUrl ?
                    <div className="header-help">
                        <a className={`ui icon help-button`} href={helpUrl} target="_docs" role="link" aria-label={lf("Help on {0} dialog", header)} title={lf("Help on {0} dialog", header)}>
                            <Icon icon="help" />
                        </a>
                    </div>
                    : undefined}
            </div> : undefined}
            {isFullscreen && headerActions ? <div className="header-actions">{headerActions}</div> : undefined}
            {!isFullscreen && description ? <label id={this.id + 'description'} className="accessible-hidden">{description}</label> : undefined}
            <div id={this.id + 'desc'} className={`${longer ? 'scrolling' : ''} ${headerActions ? 'has-actions' : ''} content`}>
                {children}
            </div>
            {!isFullscreen && this.props.buttons && this.props.buttons.length > 0 ?
                <div className="actions">
                    {this.props.buttons.map(action =>
                        action.url ?
                            <Link
                                key={`action_${action.label}`}
                                icon={action.icon}
                                text={action.label}
                                title={action.title || action.label}
                                className={`ui button approve ${action.icon ? 'icon right' : ''} ${(action.label && !action.urlButton) ? 'labeled' : ''} ${action.className || ''} ${action.loading ? "loading disabled" : ""} ${action.disabled ? "disabled" : ""}`}
                                href={action.url}
                                target={!action.fileName ? '_blank' : undefined}
                                download={action.fileName ? pxt.Util.htmlEscape(action.fileName) : undefined}
                            />
                            : <ModalButtonElement
                                key={`action_${action.label}`}
                                {...action} labelPosition={action.labelPosition} />
                    )}
                </div> : undefined}
            {!isFullscreen && closeIcon && <CloseButton onClick={onClose} />}
        </ReactModal>
    }
}

class ModalButtonElement extends data.PureComponent<ModalButton, {}> {
    constructor(props: ModalButton) {
        super(props);
        this.state = {
        }

        this.handleClick = this.handleClick.bind(this);
    }

    handleClick() {
        if (!this.props.disabled && this.props.onclick)
            this.props.onclick();
    }

    renderCore() {
        const action = this.props;
        return <Button
            icon={action.icon}
            text={action.label}
            labelPosition={action.labelPosition}
            className={`approve ${action.icon ? `icon ${action.labelPosition ? action.labelPosition : 'right'} labeled` : ''} ${action.className || ''} ${action.loading ? "loading disabled" : ""} ${action.disabled ? "disabled" : ""}`}
            onClick={this.handleClick}
            onKeyDown={fireClickOnEnter}
            ariaLabel={this.props.ariaLabel ? this.props.ariaLabel : this.props.label}
            title={this.props.title}/>
    }
}

///////////////////////////////////////////////////////////
////////////             Dimmer               /////////////
///////////////////////////////////////////////////////////

export interface DimmerProps extends ReactModal.Props {
    className?: string;
    disabled?: boolean;
    inverted?: boolean;
    page?: boolean;
    simple?: boolean;
    active?: boolean;
    onClose?: () => void;
    closable?: boolean;
}

export interface DimmerState {
}

export class Dimmer extends UIElement<DimmerProps, DimmerState> {

    render() {
        const { disabled, inverted, page, simple,
            closable, onClose, active, children, ...rest } = this.props;
        const portalClasses = cx([
            'ui dimmer',
            active ? 'active transition visible' : '',
            disabled ? 'disabled' : '',
            inverted ? 'inverted' : '',
            page ? 'page' : '',
            simple ? 'simple' : ''
        ])
        const customStyles = {
            content: {
                background: 'none',
                border: '0'
            }
        }
        return <ReactModal
            appElement={appElement}
            style={customStyles}
            shouldCloseOnOverlayClick={closable}
            onRequestClose={onClose}
            overlayClassName={portalClasses}
            role="dialog"
            {...rest}>
            {children}
        </ReactModal>
    }
}

///////////////////////////////////////////////////////////
////////////             Loader               /////////////
///////////////////////////////////////////////////////////

export interface LoaderProps {
    active?: boolean;
    className?: string;
    disabled?: boolean;
    inverted?: boolean;
    size?: SIZES
}

export class Loader extends UIElement<LoaderProps, {}> {

    render() {
        const { active, children, disabled, inverted, size, className } = this.props;
        const classes = cx([
            'ui loader',
            size,
            active ? 'active' : '',
            disabled ? 'disabled' : '',
            inverted ? 'inverted' : '',
            children ? 'text' : '',
            className
        ])
        return <div
            className={classes}>
            {children}
        </div>
    }
}

///////////////////////////////////////////////////////////
////////////           Tooltip                /////////////
///////////////////////////////////////////////////////////

export interface TooltipUIProps {
    tooltip?: string;
    tooltipId?: string;
    tooltipDelayShow?: number;
    tooltipPlace?: "top" | "left" | "right" | "bottom";
}

export interface TooltipProps extends ReactTooltip.Props {
    content: string;
}

export class Tooltip extends React.Component<TooltipProps, {}> {

    constructor(props: TooltipProps) {
        super(props);
        this.state = {
        }
    }

    render() {
        const { id, content, className, ...rest } = this.props;

        return <div>
            <div data-tip='tooltip' data-for={id}>
                {this.props.children}
            </div>
            <ReactTooltip id={id} className={`pxt-tooltip ${className || ''}`} effect='solid' {...rest}>
                {content}
            </ReactTooltip>
        </div>
    }
}

///////////////////////////////////////////////////////////
////////////             SVG Loader           /////////////
///////////////////////////////////////////////////////////


export interface ProgressCircleProps {
    progress: number; // progress in int from 1 - steps
    steps: number; // max number of steps
    stroke: number;
}

export class ProgressCircle extends React.Component<ProgressCircleProps, {}> {
    protected radius: number = 100 / (2 * Math.PI); // 100 steps in circle
    protected view: number;
    constructor(props: ProgressCircleProps) {
        super(props);
        this.view = this.radius * 2 + this.props.stroke;
    }

    getPathStyle() {
        return { strokeWidth: this.props.stroke }
    }

    render() {
        let props = this.props;
        let r = this.radius;

        return <div className="progresscircle">
            <svg viewBox={`0 0 ${this.view} ${this.view}`} aria-labelledby="circletitle" role="img">
                <title id="circletitle">Currently on step {props.progress} of {props.steps}</title>
                <path style={this.getPathStyle()}
                    strokeDasharray={`${Math.round(100 * props.progress / props.steps)}, 100`}
                    d={`M${this.view / 2} ${props.stroke / 2} a ${r} ${r} 0 0 1 0 ${r * 2} a ${r} ${r} 0 0 1 0 -${r * 2}`} />
            </svg>
        </div>
    }
}

///////////////////////////////////////////////////////////
////////////             Plain checkbox       /////////////
///////////////////////////////////////////////////////////

export interface PlainCheckboxProps {
    label: string;
    isChecked?: boolean;
    onChange: (v: boolean) => void;
}

export interface PlainCheckboxState {
    isChecked: boolean;
}

export class PlainCheckbox extends data.Component<PlainCheckboxProps, PlainCheckboxState> {
    constructor(props: PlainCheckboxProps) {
        super(props);
        this.state = {
            isChecked: this.props.isChecked
        }
        this.setCheckedBit = this.setCheckedBit.bind(this);
    }

    setCheckedBit() {
        let val = !this.state.isChecked
        this.props.onChange(val)
        this.setState({ isChecked: val })
    }

    renderCore() {
        return <Checkbox
            inputLabel={this.props.label}
            checked={this.state.isChecked}
            onChange={this.setCheckedBit} />
    }
}
