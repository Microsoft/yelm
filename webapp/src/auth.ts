import * as core from "./core";
import * as data from "./data";
import * as cloud from "./cloud";

export class Component<TProps, TState> extends data.Component<TProps, TState> {
    public getUserProfile(): pxt.auth.UserProfile {
        return this.getData<pxt.auth.UserProfile>(pxt.auth.USER_PROFILE);
    }
    public getUserPreferences(): pxt.auth.UserPreferences {
        return this.getData<pxt.auth.UserPreferences>(pxt.auth.USER_PREFERENCES);
    }
    public isLoggedIn(): boolean {
        return this.getData<boolean>(pxt.auth.LOGGED_IN);
    }
}

class AuthClient extends pxt.auth.AuthClient {
    protected async onSignedIn(): Promise<void> {
        const state = this.getState();
        core.infoNotification(lf("Signed in: {0}", state.profile.idp.displayName));
        await cloud.syncAsync();
    }
    protected onSignedOut(): Promise<void> {
        core.infoNotification(lf("Signed out"));
        return Promise.resolve();
    }
    protected onSignInFailed(): Promise<void> {
        core.errorNotification(lf("Sign in failed. Something went wrong."));
        return Promise.resolve();
    }
    protected async onProfileDeleted(userId: string): Promise<void> {
        // Convert cloud-saved projects to local projects.
        await cloud.convertCloudToLocal(userId);
    }
    protected onApiError(err: any): Promise<void> {
        core.handleNetworkError(err);
        return Promise.resolve();
    }
}

function client() {
    if (!pxt.auth.hasIdentity()) { return undefined; }
    return pxt.auth.client() ?? new AuthClient();
}

export function hasIdentity(): boolean {
    return pxt.auth.hasIdentity();
}

export function loggedIn(): boolean {
    return pxt.data.getData<boolean>(pxt.auth.LOGGED_IN);
}

export function userProfile(): pxt.auth.UserProfile {
    return pxt.data.getData<pxt.auth.UserProfile>(pxt.auth.USER_PROFILE);
}

export function userPreferences(): pxt.auth.UserPreferences {
    return pxt.data.getData<pxt.auth.UserPreferences>(pxt.auth.USER_PREFERENCES);
}

export function authCheckAsync(): Promise<pxt.auth.UserProfile | undefined> {
    return client()?.authCheckAsync();
}

export function initialUserPreferencesAsync(): Promise<pxt.auth.UserPreferences | undefined> {
    return client()?.initialUserPreferencesAsync();
}

export function loginAsync(idp: pxt.IdentityProviderId, persistent: boolean, callbackState: pxt.auth.CallbackState = undefined): Promise<void> {
    return client()?.loginAsync(idp, persistent, callbackState);
}

export function logoutAsync(): Promise<void> {
    return client()?.logoutAsync();
}

export function updateUserPreferencesAsync(newPref: Partial<pxt.auth.UserPreferences>): Promise<void> {
    return client()?.updateUserPreferencesAsync(newPref);
}

export function deleteProfileAsync(): Promise<void> {
    return client()?.deleteProfileAsync();
}

export function apiAsync<T = any>(url: string, data?: any, method?: string): Promise<pxt.auth.ApiResult<T>> {
    return client()?.apiAsync(url, data, method);
}
