namespace pxt.tutorial {

    export interface TutorialRuleStatus {
        ruleName: string;
        ruleTurnOn: boolean;
        ruleStatus?: boolean;
        ruleMessage?: string;
        isStrict?: boolean;
        blockIds?: string[];
    }

    /**
    * Check the user's code to the map of tutorial validation rules from TutorialOptions and returns an array of TutorialRuleStatus
    * @param tutorial the tutorial
    * @param workspaceBlocks Blockly blocks used of workspace
    * @param blockinfo Typescripts of the workspace
    * @return A TutorialRuleStatus
    */
    export async function validate(tutorial: TutorialOptions, workspaceBlocks: Blockly.Block[], blockinfo: pxtc.BlocksInfo): Promise<TutorialRuleStatus[]> {

        const listOfRules = tutorial.tutorialValidationRules;
        let TutorialRuleStatuses: TutorialRuleStatus[] = classifyRules(listOfRules);

        // Check to if there are rules to valdiate and to see if there are blocks are in the workspace to compare to
        if (TutorialRuleStatuses.length > 0 && workspaceBlocks.length > 0) {
            // User blocks
            const userBlockTypes = workspaceBlocks.map(b => b.type);
            const usersBlockUsed = blockCount(userBlockTypes);
            // Tutorial blocks
            const { tutorialStepInfo, tutorialStep } = tutorial;
            const step = tutorialStepInfo[tutorialStep];
            const indexdb = await tutorialBlockList(tutorial, step);
            const tutorialBlockUsed = extractBlockSnippet(tutorial, indexdb);
            for (let i = 0; i < TutorialRuleStatuses.length; i++) {
                let currRuleToValidate = TutorialRuleStatuses[i];
                const ruleName = TutorialRuleStatuses[i].ruleName;
                const isRuleEnabled = TutorialRuleStatuses[i].ruleTurnOn;
                if (isRuleEnabled) {
                    switch (ruleName) {
                        case "exact":
                            currRuleToValidate = validateExactNumberOfBlocks(usersBlockUsed, tutorialBlockUsed, currRuleToValidate);
                            break;
                        case "atleast":
                            currRuleToValidate = validateAtleastOneBlocks(usersBlockUsed, tutorialBlockUsed, currRuleToValidate);
                            break;
                        case "required":
                            const requiredBlocksList = extractRequiredBlockSnippet(tutorial, indexdb);
                            currRuleToValidate = validateMeetRequiredBlocks(usersBlockUsed, requiredBlocksList, currRuleToValidate);
                            break;
                        case "overlap":
                            const tutorialDropdowns = tutorial.validationOverlapBlocks;
                            // TODO: Shakao - need method 
                            const userDropdowns: pxt.Map<string> = {};
                            currRuleToValidate = validateOverlapBlock(usersBlockUsed, tutorialBlockUsed, tutorialDropdowns, userDropdowns, currRuleToValidate);
                            break;
                    }
                }
            }
        }
        return TutorialRuleStatuses;
    }

    /**
    * Gives each rule from the markdown file a TutorialRuleStatus
    * @param listOfRules a map of rules from makrdown file
    * @return An array of TutorialRuleStatus
    */
    function classifyRules(listOfRules: pxt.Map<boolean>): TutorialRuleStatus[] {
        let listOfRuleStatuses: TutorialRuleStatus[] = [];
        if (listOfRules != undefined) {
            const ruleNames: string[] = Object.keys(listOfRules);
            for (let i = 0; i < ruleNames.length; i++) {
                const currRule: string = ruleNames[i];
                const ruleVal: boolean = listOfRules[currRule];
                const currRuleStatus: TutorialRuleStatus = { ruleName: currRule, ruleTurnOn: ruleVal };
                listOfRuleStatuses.push(currRuleStatus);
            }
        }
        return listOfRuleStatuses;
    }

    /**
    * Loops through an array of blocks and returns a map of blocks and the count for that block
    * @param arr a string array of blocks
    * @return a map <Block type, frequency>
    */
    function blockCount(arr: string[]): pxt.Map<number> {
        let frequencyMap: pxt.Map<number> = {};
        for (let i: number = 0; i < arr.length; i++) {
            if (!frequencyMap[arr[i]]) {
                frequencyMap[arr[i]] = 0;
            }
            frequencyMap[arr[i]] = frequencyMap[arr[i]] + 1;
        }
        return frequencyMap;
    }

    /**
    * Returns information from index database
    * @param tutorial Typescripts of the workspace
    * @param step the current tutorial step
    * @return indexdb's tutorial code snippets
    */
    function tutorialBlockList(tutorial: TutorialOptions, step: TutorialStepInfo): Promise<pxt.Map<pxt.Map<number>> | undefined> {
        return pxt.BrowserUtils.tutorialInfoDbAsync()
            .then(db => db.getAsync(tutorial.tutorial, tutorial.tutorialCode)
                .then(entry => {
                    if (entry?.snippets) {
                        return Promise.resolve(entry.snippets);
                    }
                    else {
                        return Promise.resolve(undefined);
                    }
                })
            );
    }

    /**
    * Extract the tutorial blocks used from code snippet
    * @param tutorial tutorial info
    * @param indexdb database from index
    * @return the tutorial blocks used for the current step
    */
    function extractBlockSnippet(tutorial: TutorialOptions, indexdb: pxt.Map<pxt.Map<number>>) {
        const { tutorialStepInfo, tutorialStep } = tutorial;
        const body = tutorialStepInfo[tutorialStep].hintContentMd;
        let hintCode = "";
        if (body != undefined) {
            body.replace(/((?!.)\s)+/g, "\n").replace(/``` *(block|blocks)\s*\n([\s\S]*?)\n```/gmi, function (m0, m1, m2) {
                hintCode = `{\n${m2}\n}`;
                return "";
            });
        }

        const snippetStepKey = pxt.BrowserUtils.getTutorialCodeHash([hintCode]);
        let blockMap = {};
        if (indexdb != undefined) {
            blockMap = indexdb[snippetStepKey];
        }
        return blockMap;
    }

    /**
    * Extract the required tutorial blocks  from code snippet
    * @param tutorial tutorial info
    * @param indexdb database from index
    * @return the tutorial blocks used for the current step
    */
    function extractRequiredBlockSnippet(tutorial: TutorialOptions, indexdb: pxt.Map<pxt.Map<number>>) {
        const { tutorialStep } = tutorial;
        const body = tutorial.tutorialStepInfo[tutorialStep].requiredBlockMd;
        const snippetStepKey = pxt.BrowserUtils.getTutorialCodeHash([body]);
        let blockMap = {};
        if (indexdb != undefined) {
            blockMap = indexdb[snippetStepKey];
        }
        return blockMap;
    }

    /**
    * Strict Rule: Checks if the all required number of blocks for a tutorial step is used, returns a TutorialRuleStatus
     * @param usersBlockUsed a map of user's blocks and count
     * @param tutorialBlockUsed a map of tutorial blocks and count
    * @param currRule the current rule with its TutorialRuleStatus
    * @return a tutorial rule status for currRule
    */
    function validateExactNumberOfBlocks(usersBlockUsed: pxt.Map<number>, tutorialBlockUsed: pxt.Map<number>, currRule: TutorialRuleStatus): TutorialRuleStatus {
        currRule.isStrict = true;
        const userBlockKeys = Object.keys(usersBlockUsed);
        let tutorialBlockKeys: string[] = []
        let blockIds = [];
        if (tutorialBlockUsed != undefined) {
            tutorialBlockKeys = Object.keys(tutorialBlockUsed);
        }
        let isValid = userBlockKeys.length >= tutorialBlockKeys.length; // user has enough blocks
        const message = lf("These are the blocks you seem to be missing:");
        for (let i: number = 0; i < tutorialBlockKeys.length; i++) {
            let tutorialBlockKey = tutorialBlockKeys[i];
            if (!usersBlockUsed[tutorialBlockKey]                                            // user did not use a specific block or
                || usersBlockUsed[tutorialBlockKey] < tutorialBlockUsed[tutorialBlockKey]) { // user did not use enough of a certain block
                blockIds.push(tutorialBlockKey);
                isValid = false;
            }
        }
        currRule.ruleMessage = message;
        currRule.ruleStatus = isValid;
        currRule.blockIds = blockIds;
        return currRule;
    }

    /**
    * Passive Rule: Checks if the users has at least one block type for each rule
     * @param usersBlockUsed a map of user's blocks and count
     * @param tutorialBlockUsed a map of tutorial blocks and count
    * @param currRule the current rule with its TutorialRuleStatus
    * @return a tutorial rule status for currRule
    */
    function validateAtleastOneBlocks(usersBlockUsed: pxt.Map<number>, tutorialBlockUsed: pxt.Map<number>, currRule: TutorialRuleStatus): TutorialRuleStatus {
        const userBlockKeys = Object.keys(usersBlockUsed);
        const tutorialBlockKeys = Object.keys(tutorialBlockUsed ?? {});
        let isValid = userBlockKeys.length >= tutorialBlockKeys.length; // user has enough blocks
        for (let i: number = 0; i < tutorialBlockKeys.length; i++) {
            let tutorialBlockKey = tutorialBlockKeys[i];
            if (!usersBlockUsed[tutorialBlockKey]) { // user did not use a specific block
                isValid = false;
                break;
            }
        }
        currRule.ruleStatus = isValid;
        return currRule;
    }

    /**
     * Strict Rule: Checks if the all required number of blocks for a tutorial step is used, returns a TutorialRuleStatus
     * @param usersBlockUsed a map of user's blocks and count
     * @param tutorialBlockUsed a map of tutorial blocks and count
     * @param currRule the current rule with its TutorialRuleStatus
     * @return a tutorial rule status for currRule
     */
    function validateMeetRequiredBlocks(usersBlockUsed: pxt.Map<number>, requiredBlocks: pxt.Map<number>, currRule: TutorialRuleStatus): TutorialRuleStatus {
        currRule.isStrict = true;
        let requiredBlockKeys: string[] = []
        let blockIds = [];
        if (requiredBlocks != undefined) {
            requiredBlockKeys = Object.keys(requiredBlocks);
        }
        let isValid: boolean = true;
        const message = lf("You are required to have the following block:");
        for (let i: number = 0; i < requiredBlockKeys.length; i++) {
            let requiredBlockKey = requiredBlockKeys[i];
            if (!usersBlockUsed[requiredBlockKey]) {
                blockIds.push(requiredBlockKey);
                isValid = false;
            }
        }
        currRule.ruleMessage = message;
        currRule.ruleStatus = isValid;
        currRule.blockIds = blockIds;
        return currRule;
    }

    /**
     * Strict Rule: Checks the overlap block kinds from the tutorial to the user's
     * @param usersBlockUsed a map of user's blocks and count
     * @param tutorialBlockUsed a map of tutorial blocks and count
     * @param tutorialDropdowns a map of tutorial's dropdown kinds
     * @param userDropdowns a map of user's dropdown kinds
     * @param currRule the current rule with its TutorialRuleStatus
     * @return a tutorial rule status for currRule
     */
    function validateOverlapBlock(usersBlockUsed: pxt.Map<number>, tutorialBlockUsed: pxt.Map<number>, tutorialDropdowns: pxt.Map<string>, userDropdowns: pxt.Map<string>, currRule: TutorialRuleStatus): TutorialRuleStatus {
        if (tutorialBlockUsed != undefined) {
            currRule.isStrict = true;
            let isValid = (!tutorialBlockUsed['spritesoverlap']); // if this tutorial step doesn't use an overlap, set valid to true
            let message = lf("Double check overlap's block dropdowns. Are you using: ");
            if (tutorialBlockUsed['spritesoverlap'] && usersBlockUsed['spritesoverlap']) {
                isValid = (tutorialDropdowns['kindOne'] == userDropdowns['kindOne']) && (tutorialDropdowns['kindTwo'] == userDropdowns['kindTwo']);
                if (!isValid) {
                    message = message + "kindOne: " + tutorialDropdowns['kindOne'] + " kindTwo: " + tutorialDropdowns['kindTwo'];
                }
            }
            currRule.ruleMessage = message;
            currRule.ruleStatus = isValid;
        }
        return currRule;
    }
}