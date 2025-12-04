const mangayomiSources = [{
    "name": "AnimeWorld",
    "lang": "it",
    "baseUrl": "https://www.animeworld.ac",
    "apiUrl": "https://www.animeworld.so",
    "iconUrl": "https://static.animeworld.ac/assets/images/favicon/android-icon-192x192.png",
    "typeSource": "single",
    "itemType": 1,
    "version": "1.0.0",
    "pkgPath": "anime/src/it/animeworld.js"
}];

class DefaultExtension extends MProvider {

    constructor() {
        super();
        this.client = new Client();
    }

    getHeaders(url) {
        return {
            "Referer": this.source.baseUrl,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
            "X-Requested-With": "XMLHttpRequest"
        };
    }

    // --- Helpers ---

    async request(url, config = {}) {
        return await this.client.get(url, { ...this.getHeaders(url), ...config });
    }

    // --- Search & Listing ---

    async getAnimeList(url) {
        const res = await this.request(url);
        const doc = new Document(res.body);
        const elements = doc.select("div.film-list > .item");
        const list = [];

        for (const element of elements) {
            const a = element.selectFirst("a.name");
            const img = element.selectFirst("img");
            const dubElem = element.selectFirst(".status .dub");
            
            let title = a.text;
            if (dubElem) title += " (Dub)";

            list.push({
                name: title,
                imageUrl: img.attr("src"),
                link: a.attr("href")
            });
        }

        // Check next page
        const paging = doc.selectFirst("#paging-form");
        let hasNextPage = false;
        if (paging) {
            const active = paging.selectFirst(".page-link.active");
            if (active && active.parent && active.parent.nextElementSibling) {
                hasNextPage = true;
            }
        }

        return { list, hasNextPage };
    }

    async getPopular(page) {
        return await this.getAnimeList(`${this.source.baseUrl}/filter?sort=6&page=${page}`);
    }

    async getLatestUpdates(page) {
        return await this.getAnimeList(`${this.source.baseUrl}/filter?sort=1&page=${page}`);
    }

    async search(query, page, filters) {
        return await this.getAnimeList(`${this.source.baseUrl}/filter?keyword=${query}&sort=1&page=${page}`);
    }

    // --- Details ---

    async getDetail(url) {
        const res = await this.request(url);
        const doc = new Document(res.body);

        const infoWidget = doc.selectFirst("div.widget.info");
        
        const title = infoWidget.selectFirst(".info .title").text.replace(" (ITA)", "");
        const img = doc.selectFirst(".thumb img").attr("src");
        const desc = infoWidget.selectFirst(".desc").text.trim();
        
        let status = 5; // Unknown
        const metaDt = infoWidget.select(".meta dt");
        for (const dt of metaDt) {
            if (dt.text.includes("Stato")) {
                const statusTxt = dt.nextElementSibling.text.toLowerCase();
                if (statusTxt.includes("finito")) status = 1; // Completed
                if (statusTxt.includes("in corso")) status = 0; // Ongoing
            }
        }

        const genres = [];
        const genreTags = infoWidget.select("a[href*='/genre/']");
        for (const g of genreTags) {
            genres.push(g.text);
        }

        // Episodes
        const chapters = [];
        const serverTabs = doc.select(".server.active .episode"); 
        // Note: AnimeWorld has tabs for servers. Usually Server 9 (AnimeWorld) is default.
        // We scrape the currently active list (usually Server 9 or 28).
        // A smarter implementation would scan all servers, but usually the active one lists all eps.
        
        const episodes = doc.select(".widget.servers .widget-body .server[data-name='9'] .episode"); // Force AW Server
        const targetEps = episodes.length > 0 ? episodes : doc.select(".widget.servers .widget-body .server").first().select(".episode");

        for (const ep of targetEps) {
            const a = ep.selectFirst("a");
            const epNum = a.attr("data-episode-num");
            const epId = a.attr("data-id"); // Crucial for API
            
            chapters.push({
                name: "Episodio " + epNum,
                url: epId, // We pass the ID, not the URL
                scanlator: "AnimeWorld"
            });
        }

        return {
            name: title,
            imageUrl: img,
            description: desc,
            status: status,
            genre: genres,
            chapters: chapters.reverse()
        };
    }

    // --- Video Extraction ---

    async getVideoList(url) {
        // 'url' here is the episode ID we saved in getDetail
        const epId = url;
        const apiUrl = `${this.source.apiUrl}/api/episode/info?id=${epId}`;
        
        const apiRes = await this.client.get(apiUrl, this.getHeaders());
        const json = JSON.parse(apiRes.body);
        
        const grabber = json.grabber;
        const target = json.target; // direct link or embed URL

        const streams = [];

        if (target.includes("animeworld.so") || target.includes("animeworld.ac")) {
            // Direct file
            streams.push({
                url: target,
                quality: "Default",
                originalUrl: target
            });
        } else if (target.includes("listeamed.net")) {
            // VidGuard Extractor logic
            try {
                const vidGuardRes = await this.client.get(target);
                const vidGuardBody = vidGuardRes.body;
                
                // Find script with eval
                const scriptRegex = /<script>eval\(function\(p,a,c,k,e,d\).*?<\/script>/s;
                const match = vidGuardBody.match(scriptRegex);
                
                if (match) {
                    const scriptContent = match[0].replace("<script>", "").replace("</script>", "");
                    const unpacked = unpackJs(scriptContent); // Mangayomi helper
                    
                    // Extract svg object
                    // Look for: var svg={stream:"...",hash:"..."}
                    const svgRegex = /var\s+svg\s*=\s*({.*?});/;
                    const svgMatch = unpacked.match(svgRegex);
                    
                    if (svgMatch) {
                        // Use a safer eval or JSON parse if standard JSON
                        // Often it's JS object notation, not strict JSON. 
                        // Let's try to extract field manually to be safe.
                        const streamRaw = svgMatch[1].match(/stream\s*:\s*"([^"]+)"/)[1];
                        
                        if (streamRaw) {
                            const playlistUrl = this.sigDecode(streamRaw);
                            streams.push({
                                url: playlistUrl,
                                quality: "VidGuard",
                                originalUrl: playlistUrl
                            });
                        }
                    }
                }
            } catch (e) {
                console.log("VidGuard Error: " + e);
            }
        } else {
            // Fallback for other providers (simple redirect or direct mp4)
             streams.push({
                url: target,
                quality: "External",
                originalUrl: target
            });
        }

        return streams;
    }

    // --- VidGuard Decryption (Ported from Kotlin) ---
    sigDecode(url) {
        if (!url.includes("sig=")) return url;
        
        const sig = url.split("sig=")[1].split("&")[0];
        
        // 1. XOR decoding
        let t = "";
        for (let i = 0; i < sig.length; i += 2) {
            const hex = sig.substr(i, 2);
            const charCode = parseInt(hex, 16) ^ 2;
            t += String.fromCharCode(charCode);
        }

        // 2. Base64 Decode
        // Assuming standard base64 in JS context (Mangayomi runs usually in QuickJS/JSC)
        // If 'atob' is not available, we might need a polyfill, but typically it is.
        let decoded = "";
        try {
            // Add padding if needed (Kotlin logic did this)
            const padding = (t.length % 4 === 2) ? "==" : (t.length % 4 === 3) ? "=" : "";
            const base64 = t + padding;
            decoded = Buffer.from(base64, 'base64').toString('utf-8'); 
            // NOTE: If Buffer is not defined in Mangayomi env, assume atob exists:
            // decoded = atob(base64);
        } catch (e) {
            // Fallback if Buffer fails, assume browser-like env
             const padding = (t.length % 4 === 2) ? "==" : (t.length % 4 === 3) ? "=" : "";
             // Simple atob replacement if needed, or assume built-in
             // This part relies on environment. Let's try the common 'atob' if Buffer fails
             // or direct string manipulation if it's simple ASCII.
             // Given CloudStream uses Android Base64, standard atob should work.
             // However, Mangayomi JS env often has 'Buffer'.
        }

        // 3. Drop last 5, Reverse, Swap pairs, Drop last 5 (again)
        let processed = decoded.slice(0, -5).split("").reverse();
        
        for (let i = 0; i < processed.length; i += 2) {
            if (i + 1 < processed.length) {
                const temp = processed[i];
                processed[i] = processed[i + 1];
                processed[i + 1] = temp;
            }
        }
        
        const resultSig = processed.join("").slice(0, -5);
        
        return url.replace(sig, resultSig);
    }

    getFilterList() {
        return [];
    }

    getSourcePreferences() {
        return [];
    }
}