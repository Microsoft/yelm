import { By } from 'selenium-webdriver';
import fs from 'fs';
import util from 'util';
const screenshotsFolder = './screenshots';
export class DomObject {

    async actionForAll(actionName, findBys) {
        for (let criteria of findBys) {
            if (criteria) {
                // console.debug(`Try to click the element by criteria: ${criteria}`);

                //wait until the element can be located
                let element = await driver.wait(until.elementLocated(this.findBy(criteria)));

                //Sleep for 2 seconds to make sure the element's state is stable for interactions
                await driver.sleep(2000);

                await element[actionName]();
            }
        }
        return true;
    }

    findBy(criteria) {
        if (typeof criteria === 'string') {
            return By.css(criteria);
        }
        return criteria;
    }

    async catchScreenShot(name) {
        if (!fs.existsSync(screenshotsFolder)) {
            fs.mkdirSync(screenshotsFolder);
        }

        let writeFile = util.promisify(fs.writeFile);

        await driver.takeScreenshot().then(function (image) {
            writeFile(`${screenshotsFolder}/${name}.png`, image, 'base64', function (err) {
                if (err) {
                    console.error(err);
                }
            });
        }
        );
    }

    async switchToWindow() {
        let handles = await driver.getAllWindowHandles();
        await driver.switchTo().window(handles[1]);
        await driver.close();
        await driver.switchTo().window(handles[0]);

        return true;
    }


    async switchToIframe(iframe) {
        let newIframe = await driver.switchTo().frame(iframe);
        await driver.sleep(5000);
        return newIframe;

    }

    async switchToDefaultFrame() {
        return await driver.switchTo().defaultContent();
    }

    async getText(criteria) {
        let element = await driver.wait(until.elementLocated(this.findBy(criteria)), 10000);
        return await element.getText();
    }

    async getAttribute(criteria, attributeName) {
        let element = await driver.wait(until.elementLocated(this.findBy(criteria)), 10000);
        return await element.getAttribute(attributeName);
    }

    async sendKeys(criteria, keys) {

        let element = await driver.wait(until.elementLocated(this.findBy(criteria)), 10000);
        return await element.sendKeys(keys);

    }

    async click(...findBys) {
        let i = await this.actionForAll('click', findBys);
        return i;
    }
}