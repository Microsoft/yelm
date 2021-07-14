import * as React from "react";
import * as sui from "./sui";
import * as core from "./core";
import * as auth from "./auth";
import * as cloudsync from "./cloudsync";

type ISettingsProps = pxt.editor.ISettingsProps;

export type ProfileTab = 'settings' | 'privacy' | 'my-stuff';


export type ProfileDialogProps = ISettingsProps & {
};

type ProfileDialogState = {
    visible?: boolean;
    location?: ProfileTab;
};

export class ProfileDialog extends auth.Component<ProfileDialogProps, ProfileDialogState> {
    constructor(props: ProfileDialogProps) {
        super(props);
        this.state = {
            visible: props.visible,
            location: 'my-stuff'
        };
    }

    show(location?: string) {
        location = location ?? 'my-stuff';
        this.setState({
            visible: true,
            location: location as ProfileTab
        });
    }

    hide = () => {
        this.setState({ visible: false });
    }

    handleTabClick = (id: ProfileTab) => {
        this.setState({ location: id });
    }

    renderCore() {
        const isLoggedIn = this.isLoggedIn();
        if (!isLoggedIn) return null;

        const user = this.getUserProfile();

        const github = cloudsync.githubProvider();
        const ghUser = github.user();

        return (
            <sui.Modal isOpen={this.state.visible} className="ui profiledialog" size="fullscreen"
                onClose={this.hide} dimmer={true}
                closeIcon={true} header={user?.idp?.displayName}
                closeOnDimmerClick={false}
                closeOnDocumentClick={false}
                closeOnEscape={false}
            >
                <AccountPanel parent={this} />
                { ghUser ? <GitHubPanel parent={this} /> : undefined }
                <FeedbackPanel parent={this} />
            </sui.Modal>
        );
    }
}

type PanelProps = {
    parent: ProfileDialog;
};

type AccountPanelProps = PanelProps & {
};

class AccountPanel extends sui.UIElement<AccountPanelProps, {}> {

    handleSignoutClicked = async () => {
        await auth.logoutAsync();
    }

    handleDeleteAccountClick = async () => {
        const profile = this.getData<pxt.auth.UserProfile>(pxt.auth.USER_PROFILE)
        const result = await core.confirmAsync({
            header: lf("Delete Profile"),
            body: lf("Are you sure? This cannot be reversed! Your cloud-saved projects will be converted to local projects on this device."),
            agreeClass: "red",
            agreeIcon: "trash",
            agreeLbl: lf("Confirm"),
            disagreeLbl: lf("Back to safety"),
            disagreeIcon: "arrow right",
            confirmationCheckbox: lf("I understand this is permanent. No undo.")
        });
        if (result) {
            await auth.deleteProfileAsync();
            // Exit out of the profile screen.
            this.props.parent.hide();
            core.infoNotification(lf("Profile deleted!"));
        }
    }

    renderCore() {
        const profile = this.getData<pxt.auth.UserProfile>(pxt.auth.USER_PROFILE);
        const provider = pxt.auth.identityProvider(profile.idp?.provider);

        const avatarElem = (
            <div className="profile-pic avatar">
                <img src={profile?.idp?.picture?.dataUrl} alt={lf("User")} />
            </div>
        );
        const initialsElem = (
            <div className="profile-pic avatar">
                <span>{cloudsync.userInitials(profile?.idp?.displayName)}</span>
            </div>
        );

        return (
            <div className="ui card panel">
                <div className="header-text">
                    <label>{lf("Profile")}</label>
                </div>
                {profile?.idp?.picture?.dataUrl ? avatarElem : initialsElem}
                <div className="row-span-two">
                    <label className="title">{lf("Name")}</label>
                    <p className="value">{profile?.idp?.displayName}</p>
                </div>
                <div className="row-span-two">
                    <label className="title">{lf("Username")}</label>
                    <p className="value">{profile?.idp?.username}</p>
                </div>
                <div className="row-span-two">
                    <label className="title">{lf("Provider")}</label>
                    <p className="value">{provider.name}</p>
                </div>
                <div className="row-span-two">
                    <sui.Button text={lf("Sign out")} icon={`xicon ${profile?.idp?.provider}`} ariaLabel={lf("Sign out {0}", profile?.idp?.provider)} onClick={this.handleSignoutClicked} />
                </div>
                <div className="row-span-two">
                    <sui.Link className="ui" text={lf("I want to delete my profile")} ariaLabel={lf("delete profile")} onClick={this.handleDeleteAccountClick} />
                </div>
            </div>
        );
    }
}

type GitHubPanelProps = PanelProps & {
};

class GitHubPanel extends sui.UIElement<GitHubPanelProps, {}> {

    handleUnlinkClicked = () => {
        const github = cloudsync.githubProvider();
        if (github) {
            github.logout();
        }
    }

    renderUsername(): JSX.Element {
        const github = cloudsync.githubProvider();
        const user = github.user();
        return (
            <>
                <div className="row-span-two">
                    <label className="title">{lf("Name")}</label>
                    <p className="value">{user?.name}</p>
                </div>
                <div className="row-span-two">
                    <label className="title">{lf("Username")}</label>
                    <p className="value">{user?.userName}</p>
                </div>
            </>
        )
    }

    renderUserPhoto(url: string): JSX.Element {
        return (
            <div className="profile-pic avatar">
                <img src={url} alt={lf("GitHub user photo")} />
            </div>
        );
    }

    renderUnlink(): JSX.Element {
        return (
            <div className="row-span-two">
                <sui.Button text={lf("Unlink")} icon="github" ariaLabel={lf("Unlink GitHub")} onClick={this.handleUnlinkClicked} />
            </div>
        );
    }

    renderDisconnected(): JSX.Element {
        return (
            <div className="row-span-two">
                <p className="description">{lf("You haven't linked a GitHub account.")}</p>
            </div>
        )
    }

    renderCore() {
        const github = cloudsync.githubProvider();
        if (!github) return null;
        const user = github.user();

        return (
            <div className="ui card panel">
                <div className="header-text">
                    <label>{lf("GitHub")}</label>
                </div>
                {user?.photo ? this.renderUserPhoto(user.photo) : undefined}
                {user ? this.renderUsername() : undefined}
                {user ? this.renderUnlink() : undefined}
                {!user ? this.renderDisconnected() : undefined}
            </div>
        );
    }
}

type FeedbackPanelProps = PanelProps & {
};

class FeedbackPanel extends sui.UIElement<FeedbackPanelProps, {}> {

    renderCore() {
        return (
            <div className="ui card panel">
                <div className="header-text">
                    <label>{lf("Feedback")}</label>
                </div>
                <div className="row-span-two">
                    {lf("What do you think about the Sign In & Cloud Save feature? Is there something you'd like to change? Did you encounter issues? Please let us know!")}
                </div>
                <div className="row-span-two">
                    <sui.Link className="ui" text={lf("Take the Survey")} icon="external alternate" ariaLabel={lf("Provide feedback at GitHub")} href="https://aka.ms/AAcnpaj" target="_blank" onKeyDown={sui.fireClickOnEnter} />
                </div>
            </div>
        );
    }
}
