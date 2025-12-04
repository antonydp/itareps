const mangayomiSources = [
  {
    "name": "AnimeWorld",
    "id": 192837465,
    "baseUrl": "https://www.animeworld.ac",
    "lang": "it",
    "typeSource": "single",
    "iconUrl": "https://static.animeworld.ac/assets/images/favicon/android-icon-192x192.png?s",
    "isNsfw": false,
    "hasCloudflare": false,
    "itemType": 1, 
    "version": "1.0.1",
    "pkgPath": "anime/src/it/animeworld.js"
  }
];

class DefaultExtension extends MProvider {
  constructor() {
    super();
    this.client = new Client();
  }

  getPreference(key) {
    return new SharedPreferences().get(key);
  }

  getBaseUrl() {
    return this.source.baseUrl;
  }

  getHeaders(url) {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Referer": this.getBaseUrl() + "/",
      "Origin": this.getBaseUrl(),
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7"
    };
  }

  async request(url, headers = {}) {
    const finalHeaders = { ...this.getHeaders(url), ...headers };
    return await this.client.get(url, finalHeaders);
  }

  async parseAnimeList(url) {
    const res = await this.request(url);
    
    // Controllo anti-blocco semplice
    if (res.statusCode !== 200) {
        console.log("Errore Status Code: " + res.statusCode);
    }

    const doc = new Document(res.body);
    const list = [];
    
    const items = doc.select("div.film-list > .item");
    
    for (const item of items) {
      const anchor = item.selectFirst("a.name");
      const img = item.selectFirst("a.poster img");
      
      if (!anchor) continue;

      const title = anchor.text().replace(" (ITA)", "");
      const link = anchor.attr("href");
      const imageUrl = img ? img.attr("src") : "";
      
      list.push({
        name: title,
        link: link,
        imageUrl: imageUrl
      });
    }

    let hasNextPage = false;
    const pagingWrapper = doc.selectFirst("#paging-form");
    if (pagingWrapper) {
      const totalPagesEl = pagingWrapper.selectFirst("span.total");
      if (totalPagesEl) {
        const totalPages = parseInt(totalPagesEl.text());
        // Logica semplice: se nella pagina c'è un link alla "next page" o calcolo manuale
        const currentPageEl = pagingWrapper.selectFirst("li.active span");
        if (currentPageEl) {
            const currentPage = parseInt(currentPageEl.text());
            hasNextPage = currentPage < totalPages;
        }
      }
    }

    return { list, hasNextPage };
  }

  async getPopular(page) {
    const url = `${this.getBaseUrl()}/filter?sort=6&page=${page}`;
    return await this.parseAnimeList(url);
  }

  async getLatestUpdates(page) {
    const url = `${this.getBaseUrl()}/filter?sort=1&page=${page}`;
    return await this.parseAnimeList(url);
  }

  async search(query, page, filters) {
    const url = `${this.getBaseUrl()}/filter?sort=0&keyword=${query}&page=${page}`;
    return await this.parseAnimeList(url);
  }

  async getDetail(url) {
    if (!url.startsWith("http")) {
      url = this.getBaseUrl() + url;
    }

    const res = await this.request(url);
    const doc = new Document(res.body);
    
    const widgetInfo = doc.selectFirst("div.widget.info");
    
    if (!widgetInfo) {
        // Fallback nel caso la pagina non sia caricata correttamente
        return { name: "Errore caricamento", description: "Impossibile caricare i dettagli. Riprova.", chapters: [] };
    }

    const title = widgetInfo.selectFirst(".info .title").text().replace(" (ITA)", "");
    
    let description = "";
    const longDesc = widgetInfo.selectFirst(".desc .long");
    description = longDesc ? longDesc.text() : widgetInfo.selectFirst(".desc").text();
    
    const imgEl = doc.selectFirst(".thumb img");
    const imageUrl = imgEl ? imgEl.attr("src") : "";
    
    const genre = [];
    const genresEl = widgetInfo.select(".meta a[href*='/genre/']");
    if(genresEl) {
        genresEl.forEach(el => genre.push(el.text()));
    }

    let status = 5; 
    const metaDt = widgetInfo.select(".meta dt");
    const metaDd = widgetInfo.select(".meta dd");
    
    // In Mangayomi Document, select restituisce una lista, non bisogna usare forEach se non è supportato dall'implementazione specifica
    // Usiamo un ciclo for classico per sicurezza con le liste Java/Kotlin mappate in JS
    for (let i = 0; i < metaDt.length; i++) {
      const label = metaDt[i].text();
      if (label.includes("Stato")) {
        const statusText = metaDd[i].text().toLowerCase();
        if (statusText.includes("finito")) status = 1;
        else if (statusText.includes("in corso")) status = 0;
      }
    }

    const chapters = [];
    const episodes = doc.select('.server[data-name="9"] .episode');
    
    for(const ep of episodes) {
        const aTag = ep.selectFirst("a");
        if(aTag) {
            const epNum = aTag.attr("data-episode-num");
            const epLink = aTag.attr("href");
            chapters.push({
                name: `Episodio ${epNum}`,
                url: epLink,
                episode: epNum
            });
        }
    }

    chapters.reverse();

    return {
      name: title,
      imageUrl: imageUrl,
      description: description,
      genre: genre,
      status: status,
      link: url,
      chapters: chapters
    };
  }

  async getVideoList(url) {
    if (!url.startsWith("http")) {
      url = this.getBaseUrl() + url;
    }

    const res = await this.request(url);
    const doc = new Document(res.body);

    const server9 = doc.selectFirst('.server[data-name="9"]');
    if (!server9) return [];

    const activeEp = server9.selectFirst("a.active");
    if (!activeEp) return [];

    const dataId = activeEp.attr("data-id");
    if (!dataId) return [];

    // API Call
    const apiUrl = `https://www.animeworld.so/api/episode/info?id=${dataId}`;
    
    // Qui è cruciale l'header X-Requested-With per l'API di Animeworld
    const apiRes = await this.request(apiUrl, {
      "X-Requested-With": "XMLHttpRequest",
      "Referer": url // Importante per bypassare controlli hotlink
    });

    const streams = [];
    try {
        const json = JSON.parse(apiRes.body);

        if (json.target && json.target.toLowerCase().includes("animeworld")) {
            streams.push({
                url: json.grabber,
                originalUrl: json.grabber,
                quality: "AnimeWorld Server",
                headers: this.getHeaders(json.grabber)
            });
        }
    } catch(e) {
        console.log("Errore parsing video: " + e.message);
    }

    return streams;
  }
}
