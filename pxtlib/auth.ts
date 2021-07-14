namespace pxt.auth {
    /**
     * Virtual API keys
     */
    const MODULE = "auth";
    const FIELD_USER_PROFILE = "profile";
    const FIELD_LOGGED_IN = "logged-in";
    export const USER_PROFILE = `${MODULE}:${FIELD_USER_PROFILE}`;
    export const LOGGED_IN = `${MODULE}:${FIELD_LOGGED_IN}`;

    const USER_PREF_MODULE = "user-pref";
    const FIELD_USER_PREFERENCES = "preferences";
    const FIELD_HIGHCONTRAST = "high-contrast";
    const FIELD_LANGUAGE = "language";
    const FIELD_READER = "reader";
    export const USER_PREFERENCES = `${USER_PREF_MODULE}:${FIELD_USER_PREFERENCES}`
    export const HIGHCONTRAST = `${USER_PREF_MODULE}:${FIELD_HIGHCONTRAST}`
    export const LANGUAGE = `${USER_PREF_MODULE}:${FIELD_LANGUAGE}`
    export const READER = `${USER_PREF_MODULE}:${FIELD_READER}`

    const CSRF_TOKEN = "csrf-token";
    const AUTH_LOGIN_STATE = "auth:login-state";
    const AUTH_USER_STATE = "auth:user-state";
    const X_PXT_TARGET = "x-pxt-target";

    export type ApiResult<T> = {
        resp: T;
        statusCode: number;
        success: boolean;
        err: any;
    };

    const DEV_BACKEND_DEFAULT = "";
    const DEV_BACKEND_PROD = "https://www.makecode.com";
    const DEV_BACKEND_STAGING = "https://staging.pxt.io";
    const DEV_BACKEND_LOCALHOST = "http://localhost:5500";

    const DEV_BACKEND = DEV_BACKEND_STAGING;

    let authDisabled = false;

    export type UserProfile = {
        id?: string;
        idp?: {
            provider?: pxt.IdentityProviderId;
            username?: string;
            displayName?: string;
            picture?: {
                mimeType?: string;
                width?: number;
                height?: number;
                encoded?: string;
                dataUrl?: string;
            };
        };
    };

    /**
     * User preference state that should be synced with the cloud.
     */
    export type UserPreferences = {
        language?: string;
        highContrast?: boolean;
        reader?: string;
    };

    const DEFAULT_USER_PREFERENCES: () => UserPreferences = () => ({
        highContrast: false,
        language: pxt.appTarget.appTheme.defaultLocale,
        reader: ""
    });

    /**
     * In-memory auth state. Changes to this state trigger virtual API subscription callbacks.
     */
    export type State = {
        profile?: UserProfile;
        preferences?: UserPreferences;
    };

    let _client: AuthClient;
    export function client(): AuthClient { return _client; }

    export abstract class AuthClient {
        /**
         * In-memory cache of user profile state. This is persisted in local storage.
         * DO NOT ACCESS DIRECTLY UNLESS YOU KNOW IT IS OK. Functions allowed direct
         * access are marked as such below.
         */
        private state$: Readonly<State>;

        constructor() {
            // Set global instance.
            _client = this;
        }

        protected abstract onSignedIn(): Promise<void>;
        protected abstract onSignedOut(): Promise<void>;
        protected abstract onSignInFailed(): Promise<void>;
        protected abstract onProfileDeleted(userId: string): Promise<void>;
        protected abstract onApiError(err: any): Promise<void>;

        /**
         * Starts the process of authenticating the user against the given identity
         * provider. Upon success the backend will write an http-only session cookie
         * to the response, containing the authorization token. This cookie is not
         * accessible in code, but will be included in all subsequent http requests.
         * @param idp The id of the identity provider.
         * @param persistent Whether or not to remember this login across sessions.
         * @param callbackState The URL hash and params to return to after the auth
         *  flow completes.
         */
        public async loginAsync(idp: pxt.IdentityProviderId, persistent: boolean, callbackState: CallbackState = undefined) {
            if (!hasIdentity() || !idpEnabled(idp)) { return; }

            callbackState = callbackState ?? NilCallbackState;

            const state = this.getState();

            // See if we have a valid access token already.
            if (!state.profile) { await this.authCheckAsync(); }

            const currIdp = state.profile?.idp;

            // Check if we're already signed into this identity provider.
            if (currIdp === idp) {
                pxt.debug(`loginAsync: Already signed into ${idp}.`);
                return;
            }

            this.clearState();

            // Store some continuation state in local storage so we can return to what
            // the user was doing before signing in.
            const genId = () => (Math.PI * Math.random()).toString(36).slice(2);
            const stateObj: AuthState = {
                key: genId(),
                callbackState,
                callbackPathname: window.location.pathname,
                idp,
            };
            const stateStr = JSON.stringify(stateObj);
            pxt.storage.setLocal(AUTH_LOGIN_STATE, stateStr);

            // Redirect to the login endpoint.
            const loginUrl = pxt.Util.stringifyQueryString('/api/auth/login', {
                response_type: "token",
                provider: idp,
                persistent,
                redirect_uri: `${window.location.origin}${window.location.pathname}?authcallback=1&state=${stateObj.key}`
            })
            const apiResult = await this.apiAsync<LoginResponse>(loginUrl);

            if (apiResult.success) {
                pxt.tickEvent('auth.login.start', { 'provider': idp });
                window.location.href = apiResult.resp.loginUrl;
            } else {
                await this.onSignInFailed();
            }
        }

        /**
         * Sign out the user and clear the auth token cookie.
         */
        public async logoutAsync() {
            if (!hasIdentity()) { return; }

            pxt.tickEvent('auth.logout');

            // backend will clear the cookie token and pass back the provider logout endpoint.
            await this.apiAsync('/api/auth/logout');

            // Clear csrf token so we can no longer make authenticated requests.
            pxt.storage.removeLocal(CSRF_TOKEN);

            // Update state and UI to reflect logged out state.
            this.clearState();

            // Redirect to home screen.
            if (pxt.BrowserUtils.hasWindow()) {
                window.location.href = `${window.location.origin}${window.location.pathname}`;
            }
        }

        public async deleteProfileAsync() {
            // only if we're logged in
            if (!await this.loggedInAsync()) { return; }

            const userId = this.getState()?.profile?.id;

            const res = await this.apiAsync('/api/user', null, 'DELETE');
            if (res.err) {
                await this.onApiError((res.err));
            } else {
                try {
                    // Clear csrf token so we can no longer make authenticated requests.
                    pxt.storage.removeLocal(CSRF_TOKEN);

                    try {
                        await this.onProfileDeleted(userId);
                    } catch {
                        pxt.tickEvent('auth.profile.cloudToLocalFailed');
                    }

                    // Update state and UI to reflect logged out state.
                    this.clearState();
                }
                finally {
                    pxt.tickEvent('auth.profile.deleted');
                }
            }
        }

        private initialUserPreferences_: Promise<UserPreferences | undefined> = undefined;
        public async initialUserPreferencesAsync(): Promise<UserPreferences | undefined> {
            // only if we're logged in
            if (!await this.loggedInAsync()) { return undefined; }

            if (!this.initialUserPreferences_) {
                this.initialUserPreferences_ = this.fetchUserPreferencesAsync();
            }
            return this.initialUserPreferences_;
        }

        public async userProfileAsync(): Promise<UserProfile | undefined> {
            if (!await this.loggedInAsync()) { return undefined; }
            const state = this.getState();
            return { ...state.profile };
        }

        public async userPreferencesAsync(): Promise<UserPreferences | undefined> {
            if (!await this.loggedInAsync()) { return undefined; }
            const state = this.getState();
            return { ...state.preferences };
        }

        private initialAuthCheck_: Promise<UserProfile | undefined> = undefined;
        /**
         * Checks to see if we're already logged in by trying to fetch user info from
         * the backend. If we have a valid auth token cookie, it will succeed.
         */
        public authCheckAsync(): Promise<UserProfile | undefined> {
            if (!hasIdentity()) { return undefined; }

            // Fail fast if we don't have csrf token.
            if (!pxt.storage.getLocal(CSRF_TOKEN)) { return undefined; }

            const state = this.getState();

            if (state.profile?.id) {
                if (!this.initialAuthCheck_) {
                    this.initialAuthCheck_ = Promise.resolve(state.profile);
                }
            } else if (!this.initialAuthCheck_) {
                // Optimistically try to fetch user profile. It will succeed if we have a valid
                // session cookie. Upon success, virtual api state will be updated, and the UI
                // will update accordingly.
                this.initialAuthCheck_ = this.fetchUserAsync();
            }
            return this.initialAuthCheck_;
        }

        public async loggedInAsync(): Promise<boolean> {
            await this.authCheckAsync();
            return this.hasUserId();
        }

        public async updateUserProfileAsync(opts: {
            username?: string,
            avatarUrl?: string
        }): Promise<boolean> {
            if (!await this.loggedInAsync()) { return false; }
            const state = this.getState();
            const result = await this.apiAsync<UserProfile>('/api/user/profile', {
                id: state.profile.id,
                username: opts.username,
                avatarUrl: opts.avatarUrl
            } as UserProfile);
            if (result.success) {
                // Set user profile from returned value
                await this.setUserProfileAsync(result.resp);
            }
            return result.success;
        }

        public async updateUserPreferencesAsync(newPref: Partial<UserPreferences>) {
            // Update our local state
            this.internalPrefUpdateAndInvalidate(newPref)

            // If we're not logged in, non-persistent local state is all we'll use
            if (!await this.loggedInAsync()) { return; }

            // If the user is logged in, save to cloud
            const result = await this.apiAsync<UserPreferences>('/api/user/preferences', newPref);
            if (result.success) {
                pxt.debug("Updating local user preferences w/ cloud data after result of POST")
                // Set user profile from returned value so we stay in-sync
                this.internalPrefUpdateAndInvalidate(result.resp)
            } else {
                pxt.reportError("identity", "update preferences failed", result as any);
            }
        }

        protected hasUserId(): boolean {
            if (!hasIdentity()) { return false; }
            const state = this.getState();
            return !!state.profile?.id;
        }

        private async fetchUserAsync(): Promise<UserProfile | undefined> {
            if (!hasIdentity()) { return undefined; }

            const state = this.getState();

            // We already have a user, no need to get it again.
            if (state.profile?.id) {
                return state.profile;
            }

            const result = await this.apiAsync('/api/user/profile');
            if (result.success) {
                const profile: UserProfile = result.resp;
                generateUserProfilePicDataUrl(profile);
                await this.setUserProfileAsync(profile);
                return profile;
            }
            return undefined
        }

        private async setUserProfileAsync(profile: UserProfile) {
            const wasLoggedIn = this.hasUserId();
            this.transformUserProfile(profile);
            const isLoggedIn = this.hasUserId();
            pxt.data.invalidate(USER_PROFILE);
            if (isLoggedIn !== wasLoggedIn) {
                pxt.data.invalidate(LOGGED_IN);
            }
            if (isLoggedIn && !wasLoggedIn) {
                await this.onSignedIn();
            } else if (!isLoggedIn && wasLoggedIn) {
                await this.onSignedOut();
            }
        }

        private internalPrefUpdateAndInvalidate(newPref: Partial<UserPreferences>) {
            // TODO is there a generic way to do this so we don't need to add new branches
            //  for each field that changes?

            // remember old
            const oldPref = this.getState().preferences ?? DEFAULT_USER_PREFERENCES()
            // update
            this.transformUserPreferences({
                ...oldPref,
                ...newPref
            });
            // invalidate fields that change
            if (oldPref?.highContrast !== this.getState().preferences?.highContrast) {
                pxt.data.invalidate(HIGHCONTRAST)
            }
            if (oldPref?.language !== this.getState().preferences?.language) {
                pxt.data.invalidate(LANGUAGE)
            }
            if (oldPref?.reader !== this.getState().preferences?.reader) {
                pxt.data.invalidate(READER)
            }
        }

        private async fetchUserPreferencesAsync(): Promise<UserPreferences | undefined> {
            // Wait for the initial auth
            if (!await this.loggedInAsync()) { return undefined; }

            const state = this.getState();

            const api = '/api/user/preferences';
            const result = await this.apiAsync<Partial<UserPreferences>>(api);
            if (result.success) {
                // Set user profile from returned value
                if (result.resp) {
                    // Note the cloud should send partial information back if it is missing
                    // a field. So e.g. if the language has never been set in the cloud, it won't
                    // overwrite the local state.
                    this.internalPrefUpdateAndInvalidate(result.resp);

                    // update our one-time promise for the initial load
                    return state.preferences;
                }
            } else {
                pxt.reportError("identity", `fetch ${api} failed:\n${JSON.stringify(result)}`)
            }
            return undefined
        }

        /**
         * Updates user profile state and writes it to local storage.
         * Direct access to state$ allowed.
         */
        private transformUserProfile(profile: UserProfile) {
            this.state$ = {
                ...this.state$,
                profile: {
                    ...profile
                }
            };
            this.saveState();
        }

        /**
         * Updates user preference state and writes it to local storage.
         * Direct access to state$ allowed.
         */
        private transformUserPreferences(preferences: UserPreferences) {
            this.state$ = {
                ...this.state$,
                preferences: {
                    ...preferences
                }
            };
            this.saveState();
        }

        /**
         * Read-only access to current state.
         * Direct access to state$ allowed.
         */
        protected getState(): Readonly<State> {
            if (!this.state$) {
                this.loadState();
                if (this.state$) {
                    generateUserProfilePicDataUrl(this.state$.profile);
                    pxt.data.invalidate("auth:*");
                    pxt.data.invalidate("user-pref:*");
                }
            }
            if (!this.state$) {
                this.state$ = {};
            }
            return this.state$;
        };

        /**
         * Write auth state to local storage.
         * Direct access to state$ allowed.
         */
        private saveState() {
            pxt.storage.setLocal(AUTH_USER_STATE, JSON.stringify(this.state$));
        }

        /**
         * Read cached auth state from local storage.
         * Direct access to state$ allowed.
         */
        private loadState() {
            const str = pxt.storage.getLocal(AUTH_USER_STATE);
            if (str) {
                try {
                    this.state$ = JSON.parse(str);
                } catch { }
            }
        }

        /**
         * Clear all auth state.
         * Direct access to state$ allowed.
         */
        private clearState() {
            this.state$ = {};
            pxt.storage.removeLocal(AUTH_USER_STATE);
            pxt.data.invalidate("auth:*");
            //data.invalidate("user-prefs:*"); // Should we invalidate this? Or would it be jarring visually?
        }

        /*protected*/ async apiAsync<T = any>(url: string, data?: any, method?: string): Promise<ApiResult<T>> {
            const headers: pxt.Map<string> = {};
            const csrfToken = pxt.storage.getLocal(CSRF_TOKEN);
            if (csrfToken) {
                headers["authorization"] = `mkcd ${csrfToken}`;
            }
            headers[X_PXT_TARGET] = pxt.appTarget?.id;

            url = pxt.BrowserUtils.isLocalHostDev() ? `${DEV_BACKEND}${url}` : url;

            return pxt.Util.requestAsync({
                url,
                headers,
                data,
                method: method ? method : data ? "POST" : "GET",
                withCredentials: true,  // Include cookies and authorization header in request, subject to CORS policy.
            }).then(r => {
                return {
                    statusCode: r.statusCode,
                    resp: r.json,
                    success: Math.floor(r.statusCode / 100) === 2,
                    err: null
                }
            }).catch(async (e) => {
                if (!/logout/.test(url) && e.statusCode == 401) {
                    // 401/Unauthorized. logout now.
                    await this.logoutAsync();
                }
                return {
                    statusCode: e.statusCode,
                    err: e,
                    resp: null,
                    success: false
                }
            });
        }

        public static authApiHandler(p: string) {
            const cli = client();
            if (cli) {
                const field = pxt.data.stripProtocol(p);
                const state = cli.getState();
                switch (field) {
                    case FIELD_USER_PROFILE: return { ...state.profile };
                    case FIELD_LOGGED_IN: return cli.hasUserId();
                }
            }
            return null;
        }

        public static userPreferencesHandler(path: string): UserPreferences | boolean | string {
            const cli = client();
            if (cli) {
                const state = cli.getState();
                if (!state.preferences) {
                    cli.transformUserPreferences(DEFAULT_USER_PREFERENCES());
                    /* await */ cli.initialUserPreferencesAsync();
                }
                return AuthClient.internalUserPreferencesHandler(path);
            }
            return null;
        }

        private static internalUserPreferencesHandler(path: string): UserPreferences | boolean | string {
            const cli = client();
            if (cli) {
                const state = cli.getState();
                const field = pxt.data.stripProtocol(path);
                switch (field) {
                    case FIELD_USER_PREFERENCES: return { ...state.preferences };
                    case FIELD_HIGHCONTRAST: return state.preferences.highContrast;
                    case FIELD_LANGUAGE: return state.preferences.language;
                    case FIELD_READER: return state.preferences.reader;
                }
                return state.preferences
            }
            return null;
        }
    }

    export type CallbackState = {
        hash?: string;
        params?: pxt.Map<string>;
    };

    const NilCallbackState = {
        hash: '',
        params: {}
    };

    /**
     * During login, we store some state in local storage so we know where to
     * redirect after login completes. This is the shape of that state.
     */
    type AuthState = {
        key: string;
        callbackState: CallbackState;
        callbackPathname: string;
        idp: pxt.IdentityProviderId;
    };

    type LoginResponse = {
        loginUrl: string;
    };


    export async function loginCallback(qs: pxt.Map<string>) {
        let state: AuthState;
        let callbackState: CallbackState = { ...NilCallbackState };

        do {
            // Read and remove auth state from local storage
            const stateStr = pxt.storage.getLocal(AUTH_LOGIN_STATE);
            if (!stateStr) {
                pxt.debug("Auth state not found in storge.");
                break;
            }
            pxt.storage.removeLocal(AUTH_LOGIN_STATE);

            state = JSON.parse(stateStr);
            if (typeof state !== 'object') {
                pxt.debug("Failed to parse auth state.");
                break;
            }

            const stateKey = qs['state'];
            if (!stateKey || state.key !== stateKey) {
                pxt.debug("Failed to get auth state for key");
                break;
            }

            callbackState = {
                ...NilCallbackState,
                ...state.callbackState
            };

            const error = qs['error'];
            if (error) {
                // Possible values for 'error':
                //  'invalid_request' -- Something is wrong with the request itself.
                //  'access_denied'   -- The identity provider denied the request, or user canceled it.
                const error_description = qs['error_description'];
                pxt.tickEvent('auth.login.error', { 'error': error, 'provider': state.idp });
                pxt.log(`Auth failed: ${error}:${error_description}`);
                // TODO: Is it correct to clear continuation hash?
                callbackState = { ...NilCallbackState };
                // TODO: Show a message to the user (via rewritten continuation path)?
                break;
            }

            const authToken = qs['token'];
            if (!authToken) {
                pxt.debug("Missing authToken in auth callback.")
                break;
            }

            // Store csrf token in local storage. It is ok to do this even when
            // "Remember me" wasn't selected because this token is not usable
            // without its cookie-based counterpart. When "Remember me" is false,
            // the cookie is not persisted.
            pxt.storage.setLocal(CSRF_TOKEN, authToken);

            pxt.tickEvent('auth.login.success', { 'provider': state.idp });
        } while (false);

        // Clear url parameters and redirect to the callback location.
        const hash = callbackState.hash.startsWith('#') ? callbackState.hash : `#${callbackState.hash}`;
        const params = pxt.Util.stringifyQueryString('', callbackState.params);
        const pathname = state.callbackPathname.startsWith('/') ? state.callbackPathname : `/${state.callbackPathname}`;
        const redirect = `${pathname}${hash}${params}`;
        window.location.href = redirect;
    }

    export function identityProviders(): pxt.AppCloudProvider[] {
        return Object.keys(pxt.appTarget?.cloud?.cloudProviders || {})
            .map(id => pxt.appTarget.cloud.cloudProviders[id])
            .filter(prov => prov.identity)
            .sort((a, b) => a.order - b.order);
    }

    export function identityProvider(id: pxt.IdentityProviderId): pxt.AppCloudProvider {
        return identityProviders().filter(prov => prov.id === id).shift();
    }

    export function hasIdentity(): boolean {
        return !authDisabled && !pxt.BrowserUtils.isPxtElectron() && identityProviders().length > 0;
    }

    function generateUserProfilePicDataUrl(profile: UserProfile) {
        if (profile?.idp?.picture?.encoded) {
            const url = window.URL || window.webkitURL;
            try {
                // Decode the base64 image to a data URL.
                const decoded = pxt.Util.stringToUint8Array(atob(profile.idp.picture.encoded));
                const blob = new Blob([decoded], { type: profile.idp.picture.mimeType });
                profile.idp.picture.dataUrl = url.createObjectURL(blob);
            } catch { }
        }
    }

    function idpEnabled(idp: pxt.IdentityProviderId): boolean {
        return identityProviders().filter(prov => prov.id === idp).length > 0;
    }

    export function initVirtualApi() {
        pxt.data.mountVirtualApi(USER_PREF_MODULE, {
            getSync: AuthClient.userPreferencesHandler,
        });
        pxt.data.mountVirtualApi(MODULE, {
            getSync: AuthClient.authApiHandler
        });
    }

    export function enableAuth(enabled = true) {
        authDisabled = !enabled
    }
}