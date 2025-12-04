const mangayomiSources = [{
    "name": "AnimeWorld",
    "lang": "it",
    "baseUrl": "https://www.animeworld.ac",
    "apiUrl": "https://www.animeworld.so",
    "iconUrl": "https://static.animeworld.ac/assets/images/favicon/android-icon-192x192.png",
    "typeSource": "single",
    "itemType": 1,
    "version": "1.0.1",
    "pkgPath": "anime/src/it/animeworld.js"
}];

class DefaultExtension extends MProvider {

    constructor() {
        super();
        this.client = new Client();
    }

    getHeaders(url) {
        return {
            "Referer": this.source.baseUrl + "/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
            "X-Requested-With": "XMLHttpRequest"
        };
    }

    async request(url) {
        return await this.client.get(url, this.getHeaders(url));
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
            
            if (!a) continue;

            let title = a.text;
            if (dubElem) title += " (Dub)";

            list.push({
                name: title,
                imageUrl: img ? img.attr("src") : "",
                link: a.attr("href")
            });
        }

        // Controllo paginazione più generico
        const nextLink = doc.selectFirst("div.paging-wrapper a#next-page");
        const nextLinkAlt = doc.selectFirst("li.next a");
        
        let hasNextPage = false;
        if (nextLink || nextLinkAlt) {
            hasNextPage = true;
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
        
        let title = infoWidget ? infoWidget.selectFirst(".info .title")?.text.replace(" (ITA)", "") : "Sconosciuto";
        const thumb = doc.selectFirst("div.thumb img");
        let img = thumb ? thumb.attr("src") : "";
        
        let desc = "";
        const descElem = doc.selectFirst(".desc") || doc.selectFirst("#info .desc");
        if (descElem) desc = descElem.text.trim();

        let status = 5; 
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

        // --- ESTRAZIONE EPISODI (FIXED) ---
        const chapters = [];
        
        // Cerchiamo il container dei server
        const serversContainer = doc.selectFirst(".widget.servers .widget-body");
        
        if (serversContainer) {
            // Cerchiamo prima il server 9 (AnimeWorld), se non c'è prendiamo il primo disponibile
            let targetServer = serversContainer.selectFirst(".server[data-name='9']");
            if (!targetServer) {
                // Se non c'è il 9, proviamo a prendere quello "active" o il primo della lista
                targetServer = serversContainer.selectFirst(".server.active") || serversContainer.selectFirst(".server");
            }

            if (targetServer) {
                // Selettore più specifico per evitare link spazzatura
                const episodeLinks = targetServer.select("li.episode > a");

                for (const el of episodeLinks) {
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
        // Chiamata API per ottenere il link reale
        const apiUrl = `${this.source.apiUrl}/api/episode/info?id=${epId}`;
        
        const apiRes = await this.client.get(apiUrl, this.getHeaders(this.source.baseUrl));
        
        if (!apiRes.body) return [];

        let json;
        try {
            json = JSON.parse(apiRes.body);
        } catch(e) {
            return [];
        }
        
        const grabber = json.grabber;
        const target = json.target;
        const streams = [];

        // 1. Link Diretto (Grabber) - Solitamente il più affidabile su AW
        if (grabber && (grabber.includes("animeworld") || grabber.includes("http"))) {
            streams.push({
                url: grabber,
                quality: "AnimeWorld Server",
                originalUrl: grabber,
                headers: {
                    "Referer": this.source.baseUrl,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
                }
            });
        } 
        
        // 2. Fallback su Target se Grabber fallisce o non esiste
        if (target && !streams.length) {
             streams.push({
                url: target,
                quality: "External/Embed",
                originalUrl: target
            });
        }

        return streams;
    }

    getFilterList() {
        return [];
    }

    getSourcePreferences() {
        return [];
    }
}
