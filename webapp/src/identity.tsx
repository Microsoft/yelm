import * as React from "react";
import * as sui from "./sui";
import * as core from "./core";
import * as auth from "./auth";
import * as data from "./data";
import * as cloudsync from "./cloudsync";
import * as cloud from "./cloud";

type ISettingsProps = pxt.editor.ISettingsProps;

export type LoginDialogProps = ISettingsProps & {
};

export type LoginDialogState = {
    visible?: boolean;
    rememberMe?: boolean;
    continuationHash?: string;
};

export class LoginDialog extends auth.Component<LoginDialogProps, LoginDialogState> {

    constructor(props: any) {
        super(props);

        this.state = {
            visible: false,
            rememberMe: false,
            continuationHash: ""
        };
    }

    private handleRememberMeChanged = (v: boolean) => {
        this.setState({ rememberMe: v });
    }

    public async show(continuationHash?: string) {
        this.setState({ visible: true, continuationHash });
    }

    public hide = () => {
        this.setState({ visible: false });
    }

    renderCore() {
        const { visible } = this.state;
        const providers = pxt.auth.identityProviders();

        return (
            <sui.Modal isOpen={visible} className="signindialog" size="tiny"
                onClose={this.hide} dimmer={true}
                closeIcon={true} header={lf("Sign in or Signup")}
                closeOnDimmerClick closeOnDocumentClick closeOnEscape>
                <div className="description">
                    <p>{lf("Connect an existing account in order to sign in or signup for the first time.")} <sui.Link className="ui" text={lf("Learn more")} icon="external alternate" ariaLabel={lf("Learn more")} href="https://aka.ms/cloudsave" target="_blank" onKeyDown={sui.fireClickOnEnter} /></p>
                </div>
                <div className="container">
                    <div className="prompt">
                        <p>Choose an account to connect:</p>
                    </div>
                    <div className="providers">
                        <div className="provider">
                            {providers.map((p, key) => (
                                <ProviderButton key={key} provider={p} rememberMe={this.state.rememberMe} continuationHash={this.state.continuationHash} />
                            ))}
                        </div>
                        <div className="remember-me">
                            <sui.PlainCheckbox label={lf("Remember me")} onChange={this.handleRememberMeChanged} />
                        </div>
                    </div>
                </div>
            </sui.Modal>
        );
    }
}

type ProviderButtonProps = {
    provider: pxt.AppCloudProvider;
    rememberMe: boolean;
    continuationHash: string;
};

class ProviderButton extends data.PureComponent<ProviderButtonProps, {}> {

    handleLoginClicked = async () => {
        const { provider, rememberMe } = this.props;
        pxt.tickEvent(`identity.loginClick`, { provider: provider.name, rememberMe: rememberMe.toString() });
        await auth.loginAsync(provider.id, rememberMe, {
            hash: this.props.continuationHash
        });
    }

    renderCore() {
        const { provider } = this.props;
        return (
            <sui.Button icon={`xicon ${provider.id}`} text={provider.name} onClick={this.handleLoginClicked} />
        );
    }
}

export type UserMenuProps = ISettingsProps & {
    continuationHash?: string;
};

type UserMenuState = {
};

export class UserMenu extends auth.Component<UserMenuProps, UserMenuState> {
    constructor(props: UserMenuProps) {
        super(props);
        this.state = {
        };
    }

    handleLoginClicked = () => {
        this.props.parent.showLoginDialog(this.props.continuationHash);
    }

    handleLogoutClicked = async () => {
        await auth.logoutAsync();
    }

    handleProfileClicked = () => {
        this.props.parent.showProfileDialog();
    }

    handleUnlinkGitHubClicked = () => {
        pxt.tickEvent("menu.github.signout");
        const githubProvider = cloudsync.githubProvider();
        if (githubProvider) {
            githubProvider.logout();
            this.props.parent.forceUpdate();
            core.infoNotification(lf("Signed out from GitHub..."))
        }
    }

    renderCore() {
        const loggedIn = this.isLoggedIn();
        const user = this.getUserProfile();
        const icon = "user large";
        const title = lf("User Menu");

        const signedOutElem = sui.genericContent({
            icon
        });
        const avatarElem = (
            <div className="avatar">
                <img src={user?.idp?.picture?.dataUrl} alt={lf("User Menu")} />
            </div>
        );
        const initialsElem = (
            <div className="avatar">
                <span>{cloudsync.userInitials(user?.idp?.displayName)}</span>
            </div>
        );
        const signedInElem = user?.idp?.picture?.dataUrl ? avatarElem : initialsElem;

        let pictureElem: React.ReactNode;
        if (user?.idp?.picture?.dataUrl) {
            pictureElem = (
                <div className="avatar">
                    <img src={user.idp.picture.dataUrl} alt={title} />
                </div>
            );
        }

        const githubUser = this.getData("github:user") as pxt.editor.UserInfo;
        const showGhUnlink = !loggedIn && githubUser;

        return (
            <sui.DropdownMenu role="menuitem"
                title={title}
                className="item icon user-dropdown-menuitem"
                titleContent={loggedIn ? signedInElem : signedOutElem}
            >
                {loggedIn ? <sui.Item role="menuitem" text={lf("My Profile")} onClick={this.handleProfileClicked} /> : undefined}
                {loggedIn ? <div className="ui divider"></div> : undefined}
                {showGhUnlink ?
                    <sui.Item role="menuitem" title={lf("Unlink {0} from GitHub", githubUser.name)} onClick={this.handleUnlinkGitHubClicked}>
                        <div className="icon avatar" role="presentation">
                            <img className="circular image" src={githubUser.photo} alt={lf("User picture")} />
                        </div>
                        <span>{lf("Unlink GitHub")}</span>
                    </sui.Item>
                    : undefined}
                {showGhUnlink ? <div className="ui divider"></div> : undefined}
                {!loggedIn ? <sui.Item role="menuitem" text={lf("Sign in")} onClick={this.handleLoginClicked} /> : undefined}
                {loggedIn ? <sui.Item role="menuitem" text={lf("Sign out")} onClick={this.handleLogoutClicked} /> : undefined}
            </sui.DropdownMenu>
        );
    }
}

export type CloudSaveStatusProps = {
    headerId: string;
};

export class CloudSaveStatus extends data.Component<CloudSaveStatusProps, {}> {
    public static wouldRender(headerId: string): boolean {
        const cloudMd = cloud.getCloudTempMetadata(headerId);
        const cloudStatus = cloudMd.cloudStatus();
        return !!cloudStatus && cloudStatus.value !== "none" && auth.hasIdentity();
    }

    renderCore() {
        if (!this.props.headerId) { return null; }
        const cloudMd = this.getData<cloud.CloudTempMetadata>(`${cloud.HEADER_CLOUDSTATE}:${this.props.headerId}`);
        const cloudStatus = cloudMd.cloudStatus();
        const showCloudButton = !!cloudStatus && cloudStatus.value !== "none" && auth.hasIdentity();
        if (!showCloudButton) { return null; }
        const preparing = cloudStatus.value === "localEdits";
        const syncing = preparing || cloudStatus.value === "syncing";

        return (<div className="cloudstatusarea">
            {!syncing && <sui.Item className={"ui tiny cloudicon xicon " + cloudStatus.icon} title={cloudStatus.tooltip} tabIndex={-1}></sui.Item>}
            {syncing && <sui.Item className={"ui tiny inline loader active cloudprogress" + (preparing ? " indeterminate" : "")} title={cloudStatus.tooltip} tabIndex={-1}></sui.Item>}
            {cloudStatus.value === "localEdits" && <span className="ui mobile hide no-select cloudtext" role="note">{lf("saving...")}</span>}
            {cloudStatus.value === "syncing" && <span className="ui mobile hide no-select cloudtext" role="note">{lf("saving...")}</span>}
            {cloudStatus.value === "justSynced" && <span className="ui mobile hide no-select cloudtext" role="note">{lf("saved!")}</span>}
            {cloudStatus.value === "offline" && <span className="ui mobile hide no-select cloudtext" role="note">{lf("offline")}</span>}
            {cloudStatus.value === "conflict" && <span className="ui mobile hide no-select cloudtext" role="note">{lf("conflict!")}</span>}
        </div>);
    }
}