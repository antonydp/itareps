const mangayomiSources = [
  {
    "name": "AnimeWorld",
    "id": 729461239,
    "lang": "it",
    "baseUrl": "https://www.animeworld.ac",
    "apiUrl": "https://www.animeworld.so/api",
    "iconUrl": "https://static.animeworld.ac/assets/images/favicon/android-icon-192x192.png?s",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "version": "1.0.0",
    "pkgPath": "anime/src/it/animeworld.js"
  }
];

class DefaultExtension extends MProvider {
  constructor() {
    super();
    this.client = new Client();
  }

  getHeaders(url) {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
      "Referer": this.source.baseUrl + "/",
      "X-Requested-With": "XMLHttpRequest"
    };
  }

  getPreference(key) {
    return new SharedPreferences().get(key);
  }

  // --- Helpers ---

  async request(url, headers = {}) {
    return await this.client.get(url, { ...this.getHeaders(url), ...headers });
  }

  // Helper per convertire l'elemento HTML in un oggetto anime
  parseAnimeElement(element) {
    const linkTag = element.selectFirst("a.name");
    const name = linkTag.text().replace(" (ITA)", "").trim();
    const link = linkTag.attr("href");
    const imgTag = element.selectFirst("img");
    const imageUrl = imgTag ? imgTag.attr("src") : "";
    return { name, link, imageUrl };
  }

  // --- Home / Search ---

  async getAnimeList(url) {
    const res = await this.request(url);
    const doc = new Document(res.body);
    const list = [];
    
    // Gestione lista standard
    const items = doc.select("div.film-list > .item");
    if (items && items.length > 0) {
      items.forEach(item => {
        list.push(this.parseAnimeElement(item));
      });
    } else {
        // Gestione lista Top (struttura diversa)
        const topItems = doc.select("div.row .content");
        topItems.forEach(item => {
            const linkTag = item.selectFirst("div.info > div.main > a");
            const name = linkTag.text().replace(" (ITA)", "").trim();
            const link = linkTag.attr("href");
            const imgTag = item.selectFirst("img");
            const imageUrl = imgTag ? imgTag.attr("src") : "";
            list.push({ name, link, imageUrl });
        });
    }

    const pagingWrapper = doc.selectFirst("#paging-form");
    let hasNextPage = false;
    if (pagingWrapper) {
        // Logica semplificata: se c'è il pulsante per la pagina successiva o l'input page non è all'ultimo
        const activePage = parseInt(pagingWrapper.selectFirst("li.active span").text());
        const totalPages = parseInt(pagingWrapper.selectFirst("span.total").text());
        hasNextPage = activePage < totalPages;
    }

    return { list, hasNextPage };
  }

  async getPopular(page) {
    // "Più Visti" -> sort=6
    return await this.getAnimeList(`${this.source.baseUrl}/filter?sort=6&page=${page}`);
  }

  async getLatestUpdates(page) {
    // "Ultimi aggiunti" -> sort=1
    return await this.getAnimeList(`${this.source.baseUrl}/filter?sort=1&page=${page}`);
  }

  async search(query, page, filters) {
    let url = `${this.source.baseUrl}/filter?page=${page}`;
    
    if (query) {
        url += `&keyword=${encodeURIComponent(query)}`;
    }

    let sort = "0"; // Default relevance
    let genres = [];
    let types = [];
    let status = "0";
    let dub = "0"; // 0 = all, 1 = sub, 2 = dub (custom logic based on preference usually)

    if (filters) {
        for (const filter of filters) {
            if (filter.type_name === "SelectFilter") {
                if (filter.name === "Ordina per") sort = filter.values[filter.state].value;
                if (filter.name === "Stato") status = filter.values[filter.state].value;
                if (filter.name === "Audio") dub = filter.values[filter.state].value;
            } else if (filter.type_name === "GroupFilter") {
                if (filter.name === "Generi") {
                    filter.state.forEach(opt => { if (opt.state) genres.push(opt.value); });
                }
                if (filter.name === "Tipo") {
                    filter.state.forEach(opt => { if (opt.state) types.push(opt.value); });
                }
            }
        }
    }

    url += `&sort=${sort}`;
    url += `&status=${status}`;
    
    // Gestione Generi
    genres.forEach(g => url += `&genre=${g}`);
    // Gestione Tipo
    types.forEach(t => url += `&type=${t}`);
    
    // Gestione Audio (Filtro custom animeworld: language=it per dub, language=jp per sub)
    if (dub === "1") url += "&language=jp";
    if (dub === "2") url += "&language=it";

    return await this.getAnimeList(url);
  }

  // --- Details ---

  async getDetail(url) {
    const res = await this.request(this.source.baseUrl + url);
    const doc = new Document(res.body);

    const widget = doc.selectFirst("div.widget.info");
    const infoContainer = widget.selectFirst(".info");
    
    const name = infoContainer.selectFirst(".title").text().replace(" (ITA)", "").trim();
    const imgTag = doc.selectFirst(".thumb img");
    const imageUrl = imgTag ? imgTag.attr("src") : "";
    
    let description = "";
    const descEl = widget.selectFirst(".desc");
    if (descEl) {
        const longDesc = descEl.selectFirst(".long");
        description = longDesc ? longDesc.text() : descEl.text();
    }

    // Metadata parsing
    const metaDt = widget.select(".meta dt");
    const metaDd = widget.select(".meta dd");
    let genre = [];
    let status = 5; // Unknown

    for (let i = 0; i < metaDt.length; i++) {
        const key = metaDt[i].text().trim();
        const val = metaDd[i];
        
        if (key.includes("Genere")) {
            val.select("a").forEach(a => genre.push(a.text()));
        } else if (key.includes("Stato")) {
            const statusText = val.text().trim().toLowerCase();
            if (statusText.includes("finito")) status = 1; // Completed
            else if (statusText.includes("in corso")) status = 0; // Ongoing
        }
    }

    // Episodes
    const chapters = [];
    const serverItems = doc.select(".widget.servers .server");
    let targetServer = null;

    // Cerchiamo preferibilmente il server "AnimeWorld" (ID 9) o "YouTube" o il primo disponibile
    // In AnimeWorldCore.kt usano .server[data-name="9"]
    for (const server of serverItems) {
        if (server.attr("data-name") === "9") {
            targetServer = server;
            break;
        }
    }
    // Fallback al primo server se il 9 non esiste
    if (!targetServer && serverItems.length > 0) targetServer = serverItems[0];

    if (targetServer) {
        const episodes = targetServer.select(".episode");
        episodes.forEach(ep => {
            const aTag = ep.selectFirst("a");
            const epNum = aTag.attr("data-episode-num");
            const epId = aTag.attr("data-id"); // ID interno per l'API
            
            // Per avere il link corretto al player, dobbiamo passare l'URL della pagina + l'ID episodio
            // La logica di AW richiede una chiamata API usando l'ID, ma l'ID cambia per server.
            // Memorizziamo l'ID del server AnimeWorld nell'URL del capitolo.
            // Formato URL capitolo: episodeID
            
            chapters.push({
                name: `Episodio ${epNum}`,
                url: epId, // Usiamo l'ID API direttamente
                number: parseFloat(epNum)
            });
        });
    }
    
    // Invertiamo per avere i più recenti in alto se necessario, ma AW li lista 1..N solitamente.
    // Mangayomi spesso preferisce newest first, ma per le serie anime 1->N è meglio.
    // Lasciamo l'ordine originale (1..N) o invertiamo in base alle preferenze UI.
    // chapters.reverse(); 

    return {
        name,
        imageUrl,
        description,
        genre,
        status,
        chapters
    };
  }

  // --- Video Extraction ---

  async getVideoList(url) {
    // 'url' qui è l'ID dell'episodio (data-id) estratto in getDetail
    // Chiamata API: https://www.animeworld.so/api/episode/info?id={id}
    
    const apiLink = `https://www.animeworld.so/api/episode/info?id=${url}`;
    // Headers specifici necessari per l'API
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": this.source.baseUrl + "/", // Importante
        "X-Requested-With": "XMLHttpRequest"
    };

    const res = await this.client.get(apiLink, headers);
    const data = JSON.parse(res.body);
    
    const streams = [];

    if (data.grabber && data.grabber.includes("http")) {
        // Direct link found in grabber (spesso AnimeWorld server restituisce m3u8 o mp4 qui)
        streams.push({
            url: data.grabber,
            originalUrl: data.grabber,
            quality: "Auto (AnimeWorld)",
            headers: {} 
        });
    }

    // Gestione VidGuard / listeamed.net (logica portata da VidguardExtractor.kt)
    if (data.target && (data.target.includes("listeamed.net") || data.target.includes("vidguard"))) {
         try {
             const vidGuardStreams = await this.extractVidGuard(data.target);
             streams.push(...vidGuardStreams);
         } catch(e) {
             console.log("VidGuard extraction failed: " + e);
         }
    }

    return streams;
  }

  // --- VidGuard Logic ---
  // Porting della logica da VidguardExtractor.kt
  
  async extractVidGuard(url) {
      const res = await new Client().get(url);
      const html = res.body;

      // Trova lo script con eval()
      // Regex semplice per trovare il contenuto dentro eval(function(p,a,c,k,e,d)...) o simile
      // Oppure cerca svg={stream:"..."} se non è offuscato, ma solitamente lo è.
      
      // In JS environments non-browser, eval() è rischioso o limitato. 
      // Tuttavia, in Mangayomi l'ambiente JS supporta spesso funzionalità di base.
      // Tentiamo di estrarre l'oggetto JSON direttamente se possibile.
      
      // VidGuard usa un sistema di offuscamento. Senza un motore JS completo (come Rhino in Kotlin),
      // decodificare "packed" JS è difficile. 
      // TENTATIVO: Cerchiamo la variabile svgHash o stream direttamente se presente in chiaro.
      // Se è packed, proviamo una simulazione semplice.
      
      let streamUrl = "";
      
      // Eseguiamo una regex per trovare il payload SVG se presente in chiaro (raro)
      const svgMatch = html.match(/svg\s*=\s*({.*?})/);
      let jsonSvg = null;

      if (svgMatch) {
          try {
              // Puliamo il JSON se non è valido (es. chiavi senza quote)
              const rawJson = svgMatch[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"');
              jsonSvg = JSON.parse(rawJson);
          } catch (e) {}
      }

      // Se non trovato, è offuscato.
      // Implementare un de-obfuscator JS completo qui è troppo lungo.
      // Tuttavia, VidGuard su AnimeWorld spesso risponde con il link "AnimeWorld" (ID 9) 
      // che è gestito sopra (data.grabber). Se siamo qui, il grabber era vuoto o diverso.
      
      // Nota: Il codice Kotlin usa Rhino per eseguire 'eval'. 
      // Qui non possiamo farlo affidabilmente.
      // Se il grabber diretto funziona, questo fallback potrebbe non servire spesso.
      
      if (jsonSvg && jsonSvg.stream) {
          streamUrl = this.sigDecode(jsonSvg.stream);
      } else {
          // Fallback: Provo a cercare direttamente la stringa base64 dello stream nella pagina
          // Spesso è dentro una variabile lunga.
          return []; 
      }

      if (!streamUrl) return [];

      return [{
          url: streamUrl,
          originalUrl: streamUrl,
          quality: "VidGuard",
          isM3U8: streamUrl.includes(".m3u8")
      }];
  }

  // Logica di decodifica Sig portata da Kotlin a JS
  sigDecode(url) {
      if (!url.includes("sig=")) return url;
      
      const sig = url.split("sig=")[1].split("&")[0];
      
      // 1. Chunked 2, Hex parse, XOR 2, Char
      let t = "";
      for (let i = 0; i < sig.length; i += 2) {
          const hex = sig.substr(i, 2);
          const charCode = parseInt(hex, 16) ^ 2;
          t += String.fromCharCode(charCode);
      }
      
      // 2. Base64 Decode
      // JS environment in Mangayomi has atob? Usually yes.
      let decoded = "";
      try {
        decoded = atob(t);
      } catch (e) { return url; } // Fail safe

      // 3. Drop last 5
      let arr = decoded.slice(0, -5).split("");
      
      // 4. Reverse
      arr = arr.reverse();
      
      // 5. Swap pairs (step 2)
      for (let i = 0; i < arr.length; i += 2) {
          if (i + 1 < arr.length) {
              const temp = arr[i];
              arr[i] = arr[i+1];
              arr[i+1] = temp;
          }
      }
      
      // 6. Concat and Drop last 5
      const finalSig = arr.join("").slice(0, -5);
      
      return url.replace(sig, finalSig);
  }

  // --- Filters ---

  getFilterList() {
    return [
      {
        type_name: "SelectFilter",
        name: "Ordina per",
        state: 0,
        values: [
            { type_name: "SelectOption", name: "Rilevanza", value: "0" },
            { type_name: "SelectOption", name: "Ultimi aggiunti", value: "1" },
            { type_name: "SelectOption", name: "Data di uscita", value: "2" },
            { type_name: "SelectOption", name: "Voto", value: "3" },
            { type_name: "SelectOption", name: "Titolo", value: "4" },
            { type_name: "SelectOption", name: "Più Visti", value: "6" },
        ]
      },
      {
        type_name: "SelectFilter",
        name: "Audio",
        state: 0,
        values: [
            { type_name: "SelectOption", name: "Tutti", value: "0" },
            { type_name: "SelectOption", name: "Sub ITA", value: "1" },
            { type_name: "SelectOption", name: "Dub ITA", value: "2" },
        ]
      },
      {
        type_name: "SelectFilter",
        name: "Stato",
        state: 0,
        values: [
            { type_name: "SelectOption", name: "Tutti", value: "0" },
            { type_name: "SelectOption", name: "In corso", value: "1" },
            { type_name: "SelectOption", name: "Finito", value: "2" },
            { type_name: "SelectOption", name: "Non rilasciato", value: "3" },
            { type_name: "SelectOption", name: "Droppato", value: "4" },
        ]
      },
      {
        type_name: "GroupFilter",
        name: "Tipo",
        state: [
            { type_name: "CheckBox", name: "Movie", value: "1" },
            { type_name: "CheckBox", name: "OVA", value: "2" },
            { type_name: "CheckBox", name: "ONA", value: "3" },
            { type_name: "CheckBox", name: "TV", value: "4" },
            { type_name: "CheckBox", name: "Special", value: "5" },
            { type_name: "CheckBox", name: "Music", value: "6" },
        ]
      },
      {
        type_name: "GroupFilter",
        name: "Generi",
        state: [
            { type_name: "CheckBox", name: "Arti Marziali", value: "arti-marziali" },
            { type_name: "CheckBox", name: "Avventura", value: "avventura" },
            { type_name: "CheckBox", name: "Azione", value: "azione" },
            { type_name: "CheckBox", name: "Commedia", value: "commedia" },
            { type_name: "CheckBox", name: "Demenza", value: "demenza" },
            { type_name: "CheckBox", name: "Demoni", value: "demoni" },
            { type_name: "CheckBox", name: "Dramma", value: "dramma" },
            { type_name: "CheckBox", name: "Ecchi", value: "ecchi" },
            { type_name: "CheckBox", name: "Fantasy", value: "fantasy" },
            { type_name: "CheckBox", name: "Gioco", value: "gioco" },
            { type_name: "CheckBox", name: "Harem", value: "harem" },
            { type_name: "CheckBox", name: "Hentai", value: "hentai" },
            { type_name: "CheckBox", name: "Horror", value: "horror" },
            { type_name: "CheckBox", name: "Josei", value: "josei" },
            { type_name: "CheckBox", name: "Kids", value: "kids" },
            { type_name: "CheckBox", name: "Magia", value: "magia" },
            { type_name: "CheckBox", name: "Mecha", value: "mecha" },
            { type_name: "CheckBox", name: "Militare", value: "militare" },
            { type_name: "CheckBox", name: "Mistero", value: "mistero" },
            { type_name: "CheckBox", name: "Musica", value: "musica" },
            { type_name: "CheckBox", name: "Parodia", value: "parodia" },
            { type_name: "CheckBox", name: "Polizia", value: "polizia" },
            { type_name: "CheckBox", name: "Psicologico", value: "psicologico" },
            { type_name: "CheckBox", name: "Romantico", value: "romantico" },
            { type_name: "CheckBox", name: "Samurai", value: "samurai" },
            { type_name: "CheckBox", name: "Sci-Fi", value: "sci-fi" },
            { type_name: "CheckBox", name: "Scolastico", value: "scolastico" },
            { type_name: "CheckBox", name: "Seinen", value: "seinen" },
            { type_name: "CheckBox", name: "Shoujo", value: "shoujo" },
            { type_name: "CheckBox", name: "Shoujo Ai", value: "shoujo-ai" },
            { type_name: "CheckBox", name: "Shounen", value: "shounen" },
            { type_name: "CheckBox", name: "Shounen Ai", value: "shounen-ai" },
            { type_name: "CheckBox", name: "Slice of Life", value: "slice-of-life" },
            { type_name: "CheckBox", name: "Spazio", value: "spazio" },
            { type_name: "CheckBox", name: "Sport", value: "sport" },
            { type_name: "CheckBox", name: "Storico", value: "storico" },
            { type_name: "CheckBox", name: "Superpoteri", value: "superpoteri" },
            { type_name: "CheckBox", name: "Thriller", value: "thriller" },
            { type_name: "CheckBox", name: "Vampiri", value: "vampiri" },
            { type_name: "CheckBox", name: "Veicoli", value: "veicoli" },
            { type_name: "CheckBox", name: "Yaoi", value: "yaoi" },
            { type_name: "CheckBox", name: "Yuri", value: "yuri" },
        ]
      }
    ];
  }
}
