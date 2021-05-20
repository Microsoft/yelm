/// <reference path="./tickEvent.ts" />
/// <reference path="./apptarget.ts" />

namespace ts.pxtc {
    export let __dummy = 42;
}

import pxtc = ts.pxtc

namespace ts.pxtc.Util {
    export function assert(cond: boolean, msg = "Assertion failed") {
        if (!cond) {
            debugger
            throw new Error(msg)
        }
    }

    export function flatClone<T extends Object>(obj: T): T {
        if (obj == null) return null
        let r: any = {}
        Object.keys(obj).forEach((k) => { r[k] = (obj as any)[k] })
        return r;
    }

    export function clone<T>(v: T): T {
        if (v == null) return null
        return JSON.parse(JSON.stringify(v))
    }

    export function htmlEscape(_input: string) {
        if (!_input) return _input;
        return _input.replace(/[<>&"'\n]/gu, c => `&#${c.charCodeAt(0)};`);
    }

    export function htmlUnescape(_input: string) {
        if (!_input) return _input; // null, undefined, empty string test
        return _input.replace(/(&#\d+;)/g, c => String.fromCharCode(Number(c.substr(2, c.length - 3))));
    }

    export function jsStringQuote(s: string) {
        return s.replace(/[^\w .!?\-$]/g,
            (c) => {
                let h = c.charCodeAt(0).toString(16);
                return "\\u" + "0000".substr(0, 4 - h.length) + h;
            });
    }

    export function jsStringLiteral(s: string) {
        return "\"" + jsStringQuote(s) + "\"";
    }


    // Localization functions. Please port any modifications over to pxtsim/localization.ts
    let _localizeLang: string = "en";
    let _localizeStrings: pxt.Map<string> = {};
    let _translationsCache: pxt.Map<pxt.Map<string>> = {};
    //let _didSetlocalizations = false;
    //let _didReportLocalizationsNotSet = false;
    let localizeLive = false;

    export function enableLiveLocalizationUpdates() {
        localizeLive = true;
    }

    export function liveLocalizationEnabled() {
        return localizeLive;
    }

    /**
     * Returns the current user language, prepended by "live-" if in live mode
     */
    export function localeInfo(): string {
        return `${localizeLive ? "live-" : ""}${userLanguage()}`;
    }
    /**
     * Returns current user language iSO-code. Default is `en`.
     */
    export function userLanguage(): string {
        return _localizeLang;
    }

    // This function returns normalized language code
    // For example: zh-CN this returns ["zh-CN", "zh", "zh-cn"]
    // First two are valid crowdin\makecode locale code,
    // Last all lowercase one is just for the backup when reading user defined extensions & tutorials.
    export function normalizeLanguageCode(code: string): string[] {
        const langParts = /^(\w{2})-(\w{2}$)/i.exec(code);
        if (langParts && langParts[1] && langParts[2]) {
            return [`${langParts[1].toLowerCase()}-${langParts[2].toUpperCase()}`, langParts[1].toLowerCase(),
             `${langParts[1].toLowerCase()}-${langParts[2].toLowerCase()}`];
        } else {
            return [(code || "en").toLowerCase()];
        }
    }

    export function setUserLanguage(localizeLang: string) {
        _localizeLang = normalizeLanguageCode(localizeLang)[0];
    }

    export function isUserLanguageRtl(): boolean {
        return /^ar|dv|fa|ha|he|ks|ku|ps|ur|yi/i.test(_localizeLang);
    }

    export const TRANSLATION_LOCALE = "pxt";
    export function isTranslationMode(): boolean {
        return userLanguage() == TRANSLATION_LOCALE;
    }

    export function _localize(s: string) {
        // Needs to be test in localhost / CLI
        /*if (!_didSetlocalizations && !_didReportLocalizationsNotSet) {
            _didReportLocalizationsNotSet = true;
            pxt.tickEvent("locale.localizationsnotset");
            // pxt.reportError can't be used here because of order of file imports
            // Just use console.error instead, and use an Error so stacktrace is reported
            console.error(new Error("Attempted to translate a string before localizations were set"));
        }*/
        return _localizeStrings[s] || s;
    }

    export function getLocalizedStrings() {
        return _localizeStrings;
    }

    export function setLocalizedStrings(strs: pxt.Map<string>) {
        //_didSetlocalizations = true;
        _localizeStrings = strs;
    }

    export function translationsCache() {
        return _translationsCache;
    }

    export function fmt_va(f: string, args: any[]): string {
        if (args.length == 0) return f;
        return f.replace(/\{([0-9]+)(\:[^\}]+)?\}/g, function (s: string, n: string, spec: string): string {
            let v = args[parseInt(n)];
            let r = "";
            let fmtMatch = /^:f(\d*)\.(\d+)/.exec(spec);
            if (fmtMatch) {
                let precision = parseInt(fmtMatch[2])
                let len = parseInt(fmtMatch[1]) || 0
                let fillChar = /^0/.test(fmtMatch[1]) ? "0" : " ";
                let num = (<number>v).toFixed(precision)
                if (len > 0 && precision > 0) len += precision + 1;
                if (len > 0) {
                    while (num.length < len) {
                        num = fillChar + num;
                    }
                }
                r = num;
            } else if (spec == ":x") {
                r = "0x" + v.toString(16);
            } else if (v === undefined) r = "(undef)";
            else if (v === null) r = "(null)";
            else if (v.toString) r = v.toString();
            else r = v + "";
            if (spec == ":a") {
                if (/^\s*[euioah]/.test(r.toLowerCase()))
                    r = "an " + r;
                else if (/^\s*[bcdfgjklmnpqrstvwxz]/.test(r.toLowerCase()))
                    r = "a " + r;
            } else if (spec == ":s") {
                if (v == 1) r = ""
                else r = "s"
            } else if (spec == ":q") {
                r = Util.htmlEscape(r);
            } else if (spec == ":jq") {
                r = Util.jsStringQuote(r);
            } else if (spec == ":uri") {
                r = encodeURIComponent(r).replace(/'/g, "%27").replace(/"/g, "%22");
            } else if (spec == ":url") {
                r = encodeURI(r).replace(/'/g, "%27").replace(/"/g, "%22");
            } else if (spec == ":%") {
                r = (v * 100).toFixed(1).toString() + '%';
            }
            return r;
        });
    }

    export function fmt(f: string, ...args: any[]) { return fmt_va(f, args); }

    const locStats: { [index: string]: number; } = {};
    export function dumpLocStats() {
        const r: { [index: string]: string; } = {};
        Object.keys(locStats).sort((a, b) => locStats[b] - locStats[a])
            .forEach(k => r[k] = k);
        console.log('prioritized list of strings:')
        console.log(JSON.stringify(r, null, 2));
    }

    let sForPlural = true;
    export function lf_va(format: string, args: any[]): string {
        if (!format) return format;

        locStats[format] = (locStats[format] || 0) + 1;
        let lfmt = Util._localize(format)

        if (!sForPlural && lfmt != format && /\d:s\}/.test(lfmt)) {
            lfmt = lfmt.replace(/\{\d+:s\}/g, "")
        }

        lfmt = lfmt.replace(/^\{(id|loc):[^\}]+\}/g, '');

        return fmt_va(lfmt, args);
    }

    export function lf(format: string, ...args: any[]): string {
        return lf_va(format, args);
    }
    /**
     * Similar to lf but the string do not get extracted into the loc file.
     */
    export function rlf(format: string, ...args: any[]): string {
        return lf_va(format, args);
    }

    export function lookup<T>(m: pxt.Map<T>, key: string): T {
        if (m.hasOwnProperty(key))
            return m[key]
        return null
    }

    export function isoTime(time: number) {
        let d = new Date(time * 1000)
        return Util.fmt("{0}-{1:f02.0}-{2:f02.0} {3:f02.0}:{4:f02.0}:{5:f02.0}",
            d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())
    }

    export function userError(msg: string): Error {
        let e = new Error(msg);
        (<any>e).isUserError = true;
        throw e
    }

    // small deep equals for primitives, objects, arrays. returns error message
    export function deq(a: any, b: any): string {
        if (a === b) return null;
        if (!a || !b) return "Null value";

        if (typeof a == 'object' && typeof b == 'object') {
            if (Array.isArray(a)) {
                if (!Array.isArray(b)) {
                    return "Expected array";
                }

                if (a.length != b.length) {
                    return "Expected array of length " + a.length + ", got " + b.length;
                }

                for (let i = 0; i < a.length; i++) {
                    if (deq(a[i], b[i]) != null) {
                        return "Expected array value " + a[i] + " got " + b[i];
                    }
                }
                return null;
            }

            let ak = Object.keys(a);
            let bk = Object.keys(a);
            if (ak.length != bk.length) {
                return "Expected " + ak.length + " keys, got " + bk.length;
            }

            for (let i = 0; i < ak.length; i++) {
                if (!Object.prototype.hasOwnProperty.call(b, ak[i])) {
                    return "Missing key " + ak[i];
                } else if (deq(a[ak[i]], b[ak[i]]) != null) {
                    return "Expected value of " + ak[i] + " to be " + a[ak[i]] + ", got " + b[ak[i]];
                }
            }

            return null;
        }

        return "Unable to compare " + a + ", " + b;
    }
}

const lf = ts.pxtc.Util.lf;