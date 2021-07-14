import { parseHash, getDocsIdentifier, getGithubIdentifier } from "./browserUtils";

export type ActivityStatus = "locked" | "notstarted" | "inprogress" | "completed" | "restarted";
export interface ActivityStatusInfo {
    status: ActivityStatus;
    currentStep?: number;
    maxSteps?: number;
    completedHeadedId?: string;
}

export function isMapCompleted(user: UserState, pageSource: string, map: SkillMap, skipActivity?: string) {
    if (Object.keys(map?.activities).some(k => !lookupMapProgress(user, pageSource, map.mapId)?.activityState[k]?.isCompleted && k !== skipActivity)) return false;
    return true;
}

export function isActivityCompleted(user: UserState, pageSource: string, mapId: string, activityId: string) {
    return !!(lookupActivityProgress(user, pageSource, mapId, activityId)?.isCompleted);
}

export function isMapUnlocked(user: UserState, map: SkillMap, pageSource: string) {
    for (const pre of map.prerequisites) {
        if (pre.type === "tag") {
            if (!user.completedTags[pageSource]) return false;

            const numCompleted = user.completedTags[pageSource][pre.tag];
            if (numCompleted === undefined || numCompleted < pre.numberCompleted) return false;
        }
        else if (pre.type === "map") {
            if (!isMapCompleted(user, pageSource, map)) return false;
        }
    }

    return true;
}

export function getActivityStatus(user: UserState, pageSource: string, map: SkillMap, activityId: string): ActivityStatusInfo {
    const isUnlocked = user && map && isActivityUnlocked(user, pageSource, map, activityId);

    let currentStep: number | undefined;
    let maxSteps: number | undefined;
    let status: ActivityStatus = isUnlocked ? "notstarted" : "locked";
    let completedHeadedId: string | undefined;
    if (user) {
        if (map && pageSource && !isMapUnlocked(user, map, pageSource)) {
            status = "locked";
        }
        else {
            const progress = lookupActivityProgress(user, pageSource, map.mapId, activityId);

            if (progress) {
                if (progress.isCompleted) {
                    status = (progress.currentStep && progress.maxSteps && progress.currentStep < progress.maxSteps) ?
                        "restarted" : "completed";
                    completedHeadedId = progress.headerId;
                }
                else if (progress.headerId) {
                    status = "inprogress";
                }
                currentStep = progress?.currentStep;
                maxSteps = progress?.maxSteps;
            }
        }
    }

    return { status, currentStep, maxSteps, completedHeadedId };
}

export function getCompletedTags(user: UserState, pageSource: string, maps: SkillMap[]) {
    const completed: CompletedTags = {};

    for (const map of maps) {
        for (const activityId of Object.keys(map.activities)) {
            const node = map.activities[activityId];
            if (isActivityCompleted(user, pageSource, map.mapId, node.activityId) && node.kind === "activity") {
                for (const tag of node.tags) {
                    if (!completed[tag]) completed[tag] = 0;
                    completed[tag] ++;
                }
            }
        }
    }

    return completed;
}

export function isActivityUnlocked(user: UserState, pageSource: string, map: SkillMap, activityId: string) {
    if (map.root.activityId === activityId) return true;

    return checkRecursive(map.root);

    function checkRecursive(root: MapNode) {
        if (isActivityCompleted(user, pageSource, map.mapId, root.activityId)) {
            if (root.next.some(activity => activity.activityId === activityId)) {
                return true;
            }

            for (const next of root.next) {
                if (checkRecursive(next)) return true;
            }
        }

        return false;
    }
}

export function lookupMapProgress(user: UserState, pageSource: string, mapId: string): MapState | undefined {
    return user.mapProgress[pageSource] ? user.mapProgress[pageSource][mapId] : undefined;
}

export function lookupActivityProgress(user: UserState, pageSource: string, mapId: string, activityId: string) {
    return lookupMapProgress(user, pageSource, mapId)?.activityState[activityId]
}

export function lookupPreviousActivities(map: SkillMap, activityId: string) {
    return Object.keys(map.activities)
        .filter(key => !isRewardNode(map.activities[key]))
        .filter(key => {
            return flattenRewardNodeChildren(map.activities[key])
                .map(el => el.activityId)
                .some(id => id === activityId);
        }).map(key => map.activities[key])
}

export function lookupPreviousActivityStates(user: UserState, pageSource: string, map: SkillMap, activityId: string): ActivityState[] {
    const prevActivities = lookupPreviousActivities(map, activityId);
    return prevActivities.map(activity => lookupActivityProgress(user, pageSource, map.mapId, activity.activityId))
        .filter(a => !!a) as ActivityState[];
}

// Looks up the most recently completed (user clicked "Finish") parent
export function lookupPreviousCompletedActivityState(user: UserState, pageSource: string, map: SkillMap, activityId: string) {
    const previous = lookupPreviousActivityStates(user, pageSource, map, activityId)
        .filter(state => state?.isCompleted && state.maxSteps === state.currentStep)
        .sort((a, b) => (b.completedTime || 0) - (a.completedTime || 0));
    return previous?.[0]
}

// Code carryover is enabled for unlocked activities (non-rewards) that haven't been started
export function isCodeCarryoverEnabled(user: UserState, pageSource: string, map: SkillMap, activity: MapNode) {
    if (activity.kind !== "activity") return false;

    const progress = lookupActivityProgress(user, pageSource, map.mapId, activity.activityId);
    return activity.allowCodeCarryover && isActivityUnlocked(user, pageSource, map, activity.activityId) && !progress?.headerId;
}

export function flattenRewardNodeChildren(node: MapNode): MapNode[] {
    if (!isRewardNode(node)) {
        return node.next;
    } else {
        let next: MapNode[] = [];
        node.next.forEach(el => next = next.concat(flattenRewardNodeChildren(el)))
        return next;
    }
}

export function isRewardNode(node: MapNode) {
    return node.kind === "reward" || node.kind === "completion";
}

export function applyUserUpgrades(user: UserState, currentVersion: string, pageSource: string, maps: { [key: string]: SkillMap }) {
    const oldVersion = pxt.semver.parse(user.version || "0.0.0");
    const newVersion = pxt.semver.parse(currentVersion);
    let upgradedUser = user;

    if (pxt.semver.cmp(oldVersion, newVersion) === 0) return upgradedUser;

    // version 0.0.0 -> version 0.0.1 upgrade
    // mapProgress was previously a map of learning path ID to map state
    // upgrading to key everything on pageSourceUrl
    if (pxt.semver.cmp(oldVersion, pxt.semver.parse("0.0.0")) === 0) {
        let oldMaps = user?.mapProgress && Object.keys(user?.mapProgress);
        // Double-check to see that we have the old format
        if (oldMaps?.length > 0 && !!user.mapProgress[oldMaps[0]].activityState) {
            const oldUser = user;
            const progress: { [key: string]: MapState } = {};
            const currentMaps = Object.keys(maps);
            currentMaps.forEach((m) => { if (oldUser.mapProgress[m]) progress[m] = oldUser.mapProgress[m] as any })
            upgradedUser = {
                ...oldUser,
                mapProgress: {
                    [pageSource]: progress
                }
            };
        }
    }

    return upgradedUser;
}

// Check the list of alternate source URLs; if the user has existing progress
// keyed to an alternate URL, migrate it to the current pageSourceUrl. Does not
// override existing progress if found.
export function applyUserMigrations(user: UserState, pageSource: string, alternateSources: string[]) {
    if (alternateSources.length === 0) return user;

    const progress: { [key: string]: MapState } = user.mapProgress[pageSource] || {};
    alternateSources.forEach(sourcePath => {
        const { cmd, arg } = parseHash(sourcePath);
        let identifier = arg;
        switch (cmd) {
            case "github":
                const parsed = pxt.github.parseRepoId(arg);
                const ghId = parsed && getGithubIdentifier(parsed);
                identifier = ghId?.identifier || arg;
                break;
            case "docs":
                identifier = getDocsIdentifier(arg);
                break;
        }

        let oldProgress = user.mapProgress[identifier];
        if (oldProgress) Object.keys(oldProgress).forEach(mapId => {
            if (!progress[mapId]) {
                progress[mapId] = oldProgress[mapId];
            } else {
                const activityProgress = oldProgress[mapId].activityState;
                Object.keys(activityProgress).forEach(activityId => {
                    if (!progress[mapId].activityState[activityId]) {
                        progress[mapId].activityState[activityId] = activityProgress[activityId];
                    }
                })
            }
        });
    })

    return {
        ...user,
        mapProgress: {
            ...user.mapProgress,
            [pageSource]: progress
        }
    };
}