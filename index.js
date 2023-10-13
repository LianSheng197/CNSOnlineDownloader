const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const prompt = require("prompt");
const JSDOM = require("jsdom").JSDOM;
const imgToPDF = require('image-to-pdf')

readline.emitKeypressEvents(process.stdin);

class Parser {
    /**
     * 解析從 `CNS.getImageUrl` 取得的 XML
     * @param {string} xml 
     * @returns {string}
     */
    static checksum(xml) {
        const dom = new JSDOM(xml);
        const q = selector => dom.window.document.querySelector(selector);
        const message = q("Message").textContent;

        // 格式：<StatusMsg>,<Checksum>
        // 範例：Successful!,599ce71fbcff60a1bee5fa3a0d32dc657b487360
        const checksum = message.split(",")[1];

        return checksum;
    }

    /**
     * 解析從 CNS.getMetadata 取得的 HTML
     * 只會解析第一筆資料
     * @param {string} html 
     */
    static metadata(html) {
        const dom = new JSDOM(html);
        const q = (selector, root = dom.window.document) => root.querySelector(selector);
        const qs = (selector, root = dom.window.document) => [...root.querySelectorAll(selector)];

        if (q("table")) {
            const titleZh = q(".search_form_line.name li:nth-child(1)").textContent;
            const titleEn = q(".search_form_line.name li:nth-child(2)").textContent;
            const updateDate = (() => {
                // nth-of-type 不支援 class，只能這樣篩選
                const parent = qs(".search_form_line").filter((e, i) => i === 1)[0];
                const skyblue = qs(".sky_blue", parent).filter((e, i) => i === 1)[0];
                const updateDate = skyblue.textContent.replace(/\//g, "-");

                return updateDate;
            })();
            const totalPagesHref = q(".btn_05 a").getAttribute("href");
            const totalPages = totalPagesHref.match(/accessPreview\(.+?(\d+)\);/)[1];

            return {
                titleZh,
                titleEn,
                updateDate,
                totalPages
            };
        }

        return null;
    }

    /**
     * 取得使用者輸入的文字
     * @returns {Promise<string>}
     */
    static async promptValue() {
        console.log(`如要退出程式，請輸入 "exit"`);

        const value = await new Promise(resolve => prompt.get([" "], function (err, res) {
            console.log();
            if (res) {
                resolve(res[" "]);
            } else {
                resolve(null);
            }
        }));

        if (value === "exit") {
            process.exit();
        }

        return value;
    }

    /**
     * 取得使用者輸入的值，並判斷是否為 Y/y
     * @returns {Promise<boolean>}
     */
    static async promptBoolean() {
        console.log(`如要退出程式，請輸入 "exit"`);

        const value = await new Promise(resolve => prompt.get([" "], function (err, res) {
            console.log();
            if (res) {
                resolve(res[" "]);
            } else {
                resolve(null);
            }
        }));

        if (value === "exit") {
            process.exit();
        }

        return value === "Y" || value === "y";
    }
}

class CNS {
    /**
     * 取得圖片路徑
     * @param {string} id 
     * @param {number} page 
     * @returns {Promise<string>}
     */
    static async getImageUrl(id, page) {
        const xml = await fetch("https://www.cnsonline.com.tw/preview/GetData", {
            "headers": {
                "accept": "application/xml, text/xml, */*; q=0.01",
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            },
            "body": `generalno=${id}&version=zh_TW&pageNum=${page}`,
            "method": "POST",
        }).then(
            r => r.text()
        );

        const checksum = Parser.checksum(xml);
        const url = `https://www.cnsonline.com.tw/preview/GenerateImage?generalno=${id}&version=zh_TW&pageNum=${page}&checksum=${checksum}`;

        return url;
    }

    /**
     * 搜尋
     * @param {string} id 
     */
    static async getMetadata(id) {
        const html = await fetch("https://www.cnsonline.com.tw/", {
            "headers": {
                "content-type": "application/x-www-form-urlencoded",
                "upgrade-insecure-requests": "1"
            },
            "body": `node=result&typeof=quick&locale=zh_TW&searchfield=${id}`,
            "method": "POST",
        }).then(
            r => r.text()
        );

        return Parser.metadata(html);
    }

    /**
     * 下載圖片
     * @param {string} id 
     * @param {number} page 
     * @param {string} path
     */
    static async downloadImage(id, page, rootPath) {
        const filePath = path.join(rootPath, `${page}.jpg`);
        const url = await CNS.getImageUrl(id, page);
        const res = await fetch(url);
        const fileStream = fs.createWriteStream(filePath);

        await new Promise((resolve, reject) => {
            res.body.pipe(fileStream);
            res.body.on("error", reject);
            fileStream.on("finish", resolve);
        });
    }
}

(async () => {
    while (true) {
        // ================ [搜尋關鍵字] ================ //
        console.log("========================================");
        console.log("請輸入要下載的國家標準(CNS)關鍵字（請儘可能精準，若一次找到多筆資料將只會下載第一筆）");
        const id = await Parser.promptValue();

        if(id === null) {
            continue;
        }

        console.log(`正在搜尋關鍵字 "${id}"...`);

        const metadata = await CNS.getMetadata(id);

        if (metadata === null) {
            console.log(`沒有找到符合的資料。\n\n`);
            continue;
        }

        console.log(`找到資料 (${id})：`);
        console.log(` - 中文標題：${metadata.titleZh}`);
        console.log(` - 英文標題：${metadata.titleEn}`);
        console.log(` - 最後更新日期：${metadata.updateDate}`);
        console.log(` - 頁數：${metadata.totalPages}\n`);

        console.log("是否下載這筆資料？");
        console.log(`     Y/y - 下載`);
        console.log(`   Other - 不要下載，重新搜尋其他關鍵字`);
        const confirmDownload = await Parser.promptBoolean();

        if (confirmDownload !== true) {
            continue;
        }

        // ================ [確定下載，檢查目錄] ================ //
        const root = path.join(__dirname, "downloads");

        if (!fs.existsSync(root)) {
            fs.mkdirSync(root);
        }

        const idRoot = path.join(root, id);

        if (!fs.existsSync(idRoot)) {
            fs.mkdirSync(idRoot);
        } else {
            console.log(`準備下載 ${id}，但發現存在目錄 ${idRoot}`);
            console.log(`是否取代既有的資料？`);
            console.log(`     Y/y - 取代資料，程式將把既有目錄刪除並重新下載`);
            console.log(`   Other - 保留資料，結束此次下載任務，重新搜尋其他關鍵字`);

            const confirmOverwrite = await Parser.promptBoolean();

            if (confirmOverwrite) {
                fs.rmSync(idRoot, { recursive: true, force: true });
                fs.mkdirSync(idRoot);
            } else {
                continue;
            }
        }

        // ================ [開始下載] ================ //
        for (let i = 1; i <= metadata.totalPages; i++) {
            process.stdout.write(`\r 下載中${".".repeat(i % 3 + 1)} (${i}/${metadata.totalPages})     `);
            await CNS.downloadImage(id, i, idRoot);
        }

        console.log(`\n下載完成\n`);

        // ================ [轉成 PDF 格式] ================ //
        console.log(`正在產生 PDF 檔案...`);

        const pages = readFilesSync(idRoot);
        const filePath = path.join(root, `${id}.pdf`);
        imgToPDF(pages, imgToPDF.sizes.A4).pipe(fs.createWriteStream(filePath));

        console.log(`已完成\n`);
    }

    /**
     * 取得指定目錄底下所有檔案（以檔名排序，數字模式）
     * @param {string} dir 
     * @returns {Buffer[]}
     */
    function readFilesSync(dir) {
        const files = [];

        fs.readdirSync(dir).forEach(filename => {
            const name = path.parse(filename).name;
            const filePath = path.resolve(dir, filename);
            const stat = fs.statSync(filePath);
            const isFile = stat.isFile();

            if (isFile) files.push({
                filePath,
                name
            });
        });

        files.sort((a, b) => {
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

        return files.map(e => fs.readFileSync(e.filePath));
    }
})();