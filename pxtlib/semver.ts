// see http://semver.org/

namespace pxt.semver {

    export interface Version {
        major: number;
        minor: number;
        patch: number;
        pre: string[];
        build: string[];
    }

    export function cmp(a: Version, b: Version) {
        if (!a)
            if (!b)
                return 0;
            else
                return 1;
        else if (!b)
            return -1;
        else {
            let d = a.major - b.major || a.minor - b.minor || a.patch - b.patch
            if (d) return d
            if (a.pre.length == 0 && b.pre.length > 0)
                return 1;
            if (a.pre.length > 0 && b.pre.length == 0)
                return -1;
            for (let i = 0; i < a.pre.length + 1; ++i) {
                let aa = a.pre[i]
                let bb = b.pre[i]
                if (!aa)
                    if (!bb)
                        return 0;
                    else
                        return -1;
                else if (!bb)
                    return 1;
                else if (/^\d+$/.test(aa))
                    if (/^\d+$/.test(bb)) {
                        d = parseInt(aa) - parseInt(bb)
                        if (d) return d
                    } else return -1;
                else if (/^\d+$/.test(bb))
                    return 1
                else {
                    d = U.strcmp(aa, bb)
                    if (d) return d
                }
            }
            return 0
        }
    }

    export function parse(v: string): Version {
        let r = tryParse(v)
        if (!r)
            U.userError(U.lf("'{0}' doesn't look like a semantic version number", v))
        return r
    }

    export function tryParse(v: string): Version {
        if (/^v\d/i.test(v)) v = v.slice(1)
        let m = /^(\d+)\.(\d+)\.(\d+)(-([0-9a-zA-Z\-\.]+))?(\+([0-9a-zA-Z\-\.]+))?$/.exec(v)
        if (m)
            return {
                major: parseInt(m[1]),
                minor: parseInt(m[2]),
                patch: parseInt(m[3]),
                pre: m[5] ? m[5].split(".") : [],
                build: m[7] ? m[7].split(".") : []
            }
        return null
    }

    export function stringify(v: Version) {
        let r = v.major + "." + v.minor + "." + v.patch
        if (v.pre.length)
            r += "-" + v.pre.join(".")
        if (v.build.length)
            r += "+" + v.build.join(".")
        return r
    }

    export function majorCmp(a: string, b: string) {
        let aa = tryParse(a)
        let bb = tryParse(b)
        return aa.major - bb.major;
    }

    export function strcmp(a: string, b: string) {
        let aa = tryParse(a)
        let bb = tryParse(b)
        if (!aa && !bb)
            return U.strcmp(a, b)
        else return cmp(aa, bb)
    }

    export function test() {
        console.log("Test semver")
        let d = [
            "0.9.0",
            "1.0.0-0.3.7",
            "1.0.0-alpha", "1.0.0-alpha.1",
            "1.0.0-alpha.beta", "1.0.0-beta",
            "1.0.0-beta.2", "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0-x.7.z.92",
            "1.0.0",
            "1.0.1",
            "1.9.0", "1.10.0", "1.11.0"
        ]

        for (let i = 0; i < d.length; ++i) {
            let p = parse(d[i])
            console.log(d[i], p)
            U.assert(stringify(p) == d[i])
            for (let j = 0; j < d.length; ++j) {
                let x = cmp(p, parse(d[j]))
                console.log(d[i], d[j], x)
                if (i < j)
                    U.assert(x < 0)
                else if (i > j)
                    U.assert(x > 0)
                else U.assert(x == 0)
            }
        }
    }

}