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
    "version": "1.1.1",
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": this.getBaseUrl(),
      "Origin": this.getBaseUrl()
    };
  }

  // Replica la logica di getSecurityCookie del codice Kotlin
  async ensureCookie() {
    const preferences = new SharedPreferences();
    let cookie = preferences.getString("security_cookie", "");
    
    if (!cookie) {
      const res = await this.client.get(this.getBaseUrl());
      const setCookie = res.headers["set-cookie"];
      if (setCookie) {
        cookie = setCookie.split(";")[0];
        preferences.setString("security_cookie", cookie);
      }
    }
    return cookie ? { "Cookie": cookie } : {};
  }

  async request(url, headers = {}) {
    const cookieHeader = await this.ensureCookie();
    const finalHeaders = { ...this.getHeaders(url), ...headers, ...cookieHeader };
    return await this.client.get(url, finalHeaders);
  }

  // Funzione helper per parsare la lista di anime
  async parseAnimeList(url) {
    const res = await this.request(url);
    const doc = new Document(res.body);
    const list = [];
    
    // Selettore basato su `div.film-list > .item` come nel codice Kotlin
    const items = doc.select("div.film-list > .item");
    
    for (const item of items) {
      const anchor = item.selectFirst("a.name");
      const img = item.selectFirst("a.poster img");
      const statusElement = item.selectFirst("div.status");
      
      const title = anchor.text().replace(" (ITA)", "");
      const link = anchor.attr("href");
      const imageUrl = img.attr("src");
      
      list.push({
        name: title,
        link: link,
        imageUrl: imageUrl
      });
    }

    // Logica paginazione: controlla se esiste una pagina successiva
    const pagingWrapper = doc.selectFirst("#paging-form");
    let hasNextPage = false;
    if (pagingWrapper) {
      const totalPagesEl = pagingWrapper.selectFirst("span.total");
      if (totalPagesEl) {
        const totalPages = parseInt(totalPagesEl.text());
        // Estrai il numero di pagina corrente dall'URL
        const match = url.match(/page=(\d+)/);
        const currentPage = match ? parseInt(match[1]) : 1;
        hasNextPage = currentPage < totalPages;
      }
    }

    return { list, hasNextPage };
  }

  async getPopular(page) {
    // Sort 6 = Più Visti
    const url = `${this.getBaseUrl()}/filter?sort=6&page=${page}`;
    return await this.parseAnimeList(url);
  }

  async getLatestUpdates(page) {
    // Sort 1 = Ultimi aggiunti
    const url = `${this.getBaseUrl()}/filter?sort=1&page=${page}`;
    return await this.parseAnimeList(url);
  }

  async search(query, page, filters) {
    // Sort 0 = Default/Rilevanza
    const url = `${this.getBaseUrl()}/filter?sort=0&keyword=${query}&page=${page}`;
    return await this.parseAnimeList(url);
  }

  async getDetail(url) {
    // Assicura che l'URL sia assoluto
    if (!url.startsWith("http")) {
      url = this.getBaseUrl() + url;
    }

    const res = await this.request(url);
    const doc = new Document(res.body);
    
    const widgetInfo = doc.selectFirst("div.widget.info");
    
    // Titolo e dettagli
    const title = widgetInfo.selectFirst(".info .title").text().replace(" (ITA)", "");
    let description = "";
    const longDesc = widgetInfo.selectFirst(".desc .long");
    if (longDesc) {
      description = longDesc.text();
    } else {
      description = widgetInfo.selectFirst(".desc").text();
    }
    
    const imageUrl = doc.selectFirst(".thumb img").attr("src");
    
    // Generi
    const genre = [];
    widgetInfo.select(".meta a[href*='/genre/']").forEach(el => {
      genre.push(el.text());
    });

    // Stato
    let status = 5;
    const metaDt = widgetInfo.select(".meta dt");
    const metaDd = widgetInfo.select(".meta dd");
    
    for (let i = 0; i < metaDt.length; i++) {
      const label = metaDt[i].text();
      if (label.includes("Stato")) {
        const statusText = metaDd[i].text().toLowerCase();
        if (statusText.includes("finito")) status = 1;
        else if (statusText.includes("in corso")) status = 0;
      }
    }

    // Capitoli (Episodi)
    const chapters = [];
    
    // Il codice Kotlin seleziona specificamente il server 9 (AnimeWorld Server)
    // Selettore: .server[data-name="9"] .episode
    const episodes = doc.select('.server[data-name="9"] .episode');
    
    episodes.forEach(ep => {
      const aTag = ep.selectFirst("a");
      const epNum = aTag.attr("data-episode-num");
      // Importante: usiamo l'URL della pagina dell'episodio come identificativo
      // Il formato è solitamente /play/nome-anime.ID/slug
      const epLink = aTag.attr("href");
      
      chapters.push({
        name: `Episodio ${epNum}`,
        url: epLink,
        episode: epNum
      });
    });

    // Ordina decrescente (i più recenti in alto, standard Mangayomi)
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
    // url è il link alla pagina dell'episodio (es. /play/...)
    if (!url.startsWith("http")) {
      url = this.getBaseUrl() + url;
    }

    const res = await this.request(url);
    const doc = new Document(res.body);

    // 1. Trova l'episodio corrente nel DOM per ottenere il data-id
    // L'URL contiene l'ID dell'anime e lo slug, dobbiamo trovare l'ID episodio specifico per l'API
    // Il codice Kotlin cerca dentro .widget.servers -> .server -> a[data-episode-num]
    // Un modo più diretto è cercare l'elemento attivo o fare match con l'URL corrente
    
    // Troviamo il server 9
    const server9 = doc.selectFirst('.server[data-name="9"]');
    if (!server9) return [];

    // Cerchiamo l'elemento 'active' che corrisponde all'episodio corrente
    const activeEp = server9.selectFirst("a.active");
    if (!activeEp) return [];

    const dataId = activeEp.attr("data-id");
    if (!dataId) return [];

    // 2. Chiama l'API interna
    // Kotlin: "https://www.animeworld.so/api/episode/info?id=" + data-id
    // Nota: Il codice Kotlin usa .so per l'API anche se il main è .ac. Manteniamo coerenza con Kotlin.
    const apiUrl = `https://www.animeworld.so/api/episode/info?id=${dataId}`;
    
    // Headers specifici per l'API
    const apiRes = await this.request(apiUrl, {
      "X-Requested-With": "XMLHttpRequest"
    });

    const json = JSON.parse(apiRes.body);
    const streams = [];

    // 3. Processa la risposta
    // json.target contiene il nome del provider. json.grabber contiene il link.
    if (json.target.toLowerCase().includes("animeworld")) {
      // Direct link
      streams.push({
        url: json.grabber,
        originalUrl: json.grabber,
        quality: "AnimeWorld Server",
        headers: this.getHeaders(json.grabber)
      });
    } 
    // VidGuard/listeamed.net è ignorato come richiesto.
    // Altri provider potrebbero essere aggiunti qui in futuro.

    return streams;
  }
}

