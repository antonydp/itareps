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
            "Referer": "https://www.animeworld.ac/",
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
            // Verifica sicura dei genitori/fratelli
            // In Mangayomi JS a volte la navigazione DOM è limitata,
            // quindi controlliamo se esiste un link con pagina successiva
            // Un metodo più robusto è cercare se c'è un elemento "next" o un numero > current
            const nextLink = paging.selectFirst("li.next"); // Classe comune per 'next'
            if (nextLink && !nextLink.attr("class").includes("disabled")) {
                hasNextPage = true;
            } else if (active) {
                 // Fallback: proviamo a vedere se c'è un fratello dopo quello attivo
                 // Nota: selectFirst non ritorna sempre il nodo DOM completo con parent/siblings in tutti gli ambienti JS
                 // Meglio basarsi sull'URL se possibile o sulla presenza di un link "Next >"
                 const pages = paging.select("a.page-link");
                 const lastPage = pages[pages.length - 1];
                 if (lastPage && lastPage.attr("href") !== "#") hasNextPage = true;
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
        
        let title = "Sconosciuto";
        let img = "";
        let desc = "";

        if (infoWidget) {
            title = infoWidget.selectFirst(".info .title")?.text.replace(" (ITA)", "") ?? "Sconosciuto";
            // A volte l'immagine è nel widget, a volte fuori. Proviamo il selettore generico
            const thumb = doc.selectFirst(".thumb img");
            if (thumb) img = thumb.attr("src");
            
            const descElem = infoWidget.selectFirst(".desc");
            if (descElem) desc = descElem.text.trim();
        }

        let status = 5; // Unknown
        const metaDt = infoWidget ? infoWidget.select(".meta dt") : [];
        for (const dt of metaDt) {
            if (dt.text.includes("Stato")) {
                const statusTxt = dt.nextElementSibling.text.toLowerCase();
                if (statusTxt.includes("finito")) status = 1; 
                if (statusTxt.includes("in corso")) status = 0; 
            }
        }

        const genres = [];
        const genreTags = infoWidget ? infoWidget.select("a[href*='/genre/']") : [];
        for (const g of genreTags) {
            genres.push(g.text);
        }

        // --- ESTRAZIONE EPISODI ---
        const chapters = [];
        
        const widgetBody = doc.selectFirst(".widget.servers .widget-body");
        
        if (widgetBody) {
            // Cerchiamo Server 9 (AnimeWorld)
            let targetServer = widgetBody.selectFirst(".server[data-name='9']");
            
            // Fallback
            if (!targetServer) {
                targetServer = widgetBody.selectFirst(".server");
            }

            if (targetServer) {
                const episodeElements = targetServer.select(".episode a");

                for (const el of episodeElements) {
                    const epNum = el.attr("data-episode-num");
                    const epId = el.attr("data-id"); 
                    
                    if (epId) {
                        chapters.push({
                            name: "Episodio " + epNum,
                            url: epId, 
                            scanlator: "AnimeWorld"
                        });
                    }
                }
            }
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
        const epId = url;
        const apiUrl = `${this.source.apiUrl}/api/episode/info?id=${epId}`;
        
        // Header fondamentali per l'API
        const apiRes = await this.client.get(apiUrl, this.getHeaders(this.source.baseUrl));
        
        if (!apiRes.body) return [];

        let json;
        try {
            json = JSON.parse(apiRes.body);
        } catch(e) {
            console.log("Errore parsing JSON API: " + e);
            return [];
        }
        
        const target = json.target; 
        const grabber = json.grabber; // <--- QUESTO È IL LINK DIRETTO
        const streams = [];

        if (!target) return [];

        // 1. Server Proprietario AnimeWorld (Il più comune)
        if (target.includes("animeworld.so") || target.includes("animeworld.ac")) {
            if (grabber) {
                streams.push({
                    url: grabber, // Usiamo GRABBER, non target
                    quality: "AnimeWorld Server",
                    originalUrl: grabber,
                    headers: {
                        "Referer": this.source.baseUrl // Serve per scaricare
                    }
                });
            }
        } 
        // 2. VidGuard / Listeamed
        else if (target.includes("listeamed.net")) {
            try {
                // Per VidGuard usiamo il target (l'url della pagina embed) per fare scraping
                const vidGuardRes = await this.client.get(target);
                const vidGuardBody = vidGuardRes.body;
                
                const scriptRegex = /<script>eval\(function\(p,a,c,k,e,d\).*?<\/script>/s;
                const match = vidGuardBody.match(scriptRegex);
                
                if (match) {
                    const scriptContent = match[0].replace("<script>", "").replace("</script>", "");
                    const unpacked = unpackJs(scriptContent); 
                    
                    const svgRegex = /var\s+svg\s*=\s*({.*?});/;
                    const svgMatch = unpacked.match(svgRegex);
                    
                    if (svgMatch) {
                        const streamMatch = svgMatch[1].match(/stream\s*:\s*"([^"]+)"/);
                        if (streamMatch) {
                            const streamRaw = streamMatch[1];
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
        } 
        // 3. Altri Player (Streamtape, ecc.)
        else {
             // Per streamtape e altri di solito si passa l'URL del target all'app 
             // che ha estrattori generici, oppure si prova il grabber.
             const finalUrl = grabber || target;
             streams.push({
                url: finalUrl,
                quality: "External",
                originalUrl: finalUrl
            });
        }

        return streams;
    }

    // --- VidGuard Decryption ---
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
        let decoded = "";
        try {
            // Polyfill manuale per atob se non esiste (ambiente QuickJS)
            // o uso Buffer se esiste (NodeJS env)
            if (typeof atob === 'function') {
                decoded = atob(t);
            } else if (typeof Buffer !== 'undefined') {
                decoded = Buffer.from(t, 'base64').toString('utf-8');
            } else {
                // Fallback brutale: proviamo a tornare la stringa se è già chiara,
                // ma di solito VidGuard richiede base64 reale.
                console.log("Manca atob/Buffer per decodificare Base64");
                return url; 
            }
        } catch (e) {
             console.log("Errore Base64: " + e);
             return url;
        }

        // 3. Manipolazione Stringa
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