const mangayomiSources = [
  {
    "name": "AnimeWorld",
    "lang": "it",
    "id": 161616161, // ID arbitrario, cambialo se necessario
    "baseUrl": "https://www.animeworld.ac",
    "apiUrl": "https://www.animeworld.so", // Usato per le chiamate API episodi
    "iconUrl": "https://static.animeworld.ac/assets/images/favicon/android-icon-192x192.png?s",
    "typeSource": "single",
    "itemType": 1, // 1 = Anime
    "version": "1.0.0",
    "pkgPath": "anime/src/it/animeworld.js"
  }
];

class DefaultExtension extends MProvider {
  constructor() {
    super();
    this.client = new Client();
  }

  getHeaders() {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
      "Referer": this.source.baseUrl,
      "Origin": this.source.baseUrl,
      "X-Requested-With": "XMLHttpRequest"
    };
  }

  // Helper per decodificare il parametro 'sig' di VidGuard (Porting dal Kotlin)
  sigDecode(url) {
    if (!url.includes("sig=")) return url;
    
    try {
        let sig = url.split("sig=")[1].split("&")[0];
        let t = "";
        
        // Hex decode e XOR 2
        for (let i = 0; i < sig.length; i += 2) {
            let hex = sig.substr(i, 2);
            t += String.fromCharCode(parseInt(hex, 16) ^ 2);
        }

        // Base64 Decode
        // Nota: QuickJS supporta atob solitamente. Se fallisce serve un polyfill.
        // Aggiustiamo il padding se necessario (logica Kotlin)
        let padding = t.length % 4;
        if (padding === 2) t += "==";
        else if (padding === 3) t += "=";

        // Decodifica Base64
        // In QuickJS/Mangayomi usiamo Buffer se disponibile o atob
        let decoded = "";
        if (typeof Buffer !== 'undefined') {
            decoded = Buffer.from(t, 'base64').toString('utf-8');
        } else {
            decoded = atob(t);
        }

        // Drop last 5 chars e reverse
        let tArr = decoded.slice(0, -5).split('').reverse();

        // Swap pairs
        for (let i = 0; i < tArr.length; i += 2) {
            if (i + 1 < tArr.length) {
                let temp = tArr[i];
                tArr[i] = tArr[i + 1];
                tArr[i + 1] = temp;
            }
        }

        // Join e drop last 5
        let result = tArr.join('').slice(0, -5);
        return url.replace(sig, result);
    } catch (e) {
        console.error("Errore sigDecode:", e);
        return url;
    }
  }

  getPreference(key) {
    // Implementazione base per le preferenze
    try {
        const val = new SharedPreferences().get(key);
        return val ? parseInt(val) : 0;
    } catch(e) {
        return 0;
    }
  }

  async request(url) {
    const res = await this.client.get(url, this.getHeaders());
    return new Document(res.body);
  }

  // Funzione comune per parsare la lista di anime
  parseAnimeList(doc) {
    const items = doc.select("div.film-list > .item");
    const list = [];
    
    items.forEach((item) => {
        const anchor = item.selectFirst("a.name");
        if (!anchor) return;

        const link = anchor.getHref; // es: /play/titolo.123
        const title = anchor.text.replace(" (ITA)", "");
        const poster = item.selectFirst("a.poster img").getSrc;
        
        list.push({
            name: title,
            imageUrl: poster,
            link: link
        });
    });
    return list;
  }

  async getPopular(page) {
    // Mappato su "Più Visti" del codice Kotlin
    // $mainUrl/filter?sort=6
    const url = `${this.source.baseUrl}/filter?sort=6&page=${page}`;
    const doc = await this.request(url);
    const list = this.parseAnimeList(doc);
    
    const paging = doc.selectFirst("#paging-form span.total");
    const totalPages = paging ? parseInt(paging.text) : 1;
    const hasNextPage = page < totalPages;

    return { list, hasNextPage };
  }

  async getLatestUpdates(page) {
    // Mappato su "Ultimi aggiunti" del codice Kotlin
    // $mainUrl/filter?sort=1
    const url = `${this.source.baseUrl}/filter?sort=1&page=${page}`;
    const doc = await this.request(url);
    const list = this.parseAnimeList(doc);

    const paging = doc.selectFirst("#paging-form span.total");
    const totalPages = paging ? parseInt(paging.text) : 1;
    const hasNextPage = page < totalPages;

    return { list, hasNextPage };
  }

  async search(query, page, filters) {
    // Mappato su $mainUrl/filter?sort=0&keyword=${query}
    const url = `${this.source.baseUrl}/filter?sort=0&keyword=${encodeURIComponent(query)}&page=${page}`;
    const doc = await this.request(url);
    const list = this.parseAnimeList(doc);

    const paging = doc.selectFirst("#paging-form span.total");
    const totalPages = paging ? parseInt(paging.text) : 1;
    const hasNextPage = page < totalPages;

    return { list, hasNextPage };
  }

  async getDetail(url) {
    // url arriva come /play/nome-anime.ID
    // Dobbiamo gestire il redirect o chiamare l'url completo
    const fullUrl = url.startsWith("http") ? url : this.source.baseUrl + url;
    const doc = await this.request(fullUrl);

    // Dettagli principali
    const widget = doc.selectFirst("div.widget.info");
    const title = widget.selectFirst(".info .title").text.replace(" (ITA)", "");
    const description = widget.selectFirst(".desc .long") ? widget.selectFirst(".desc .long").text : widget.selectFirst(".desc").text;
    const poster = doc.selectFirst(".thumb img").getSrc;
    
    const genre = [];
    widget.select(".meta a[href*='/genre/']").forEach(g => genre.push(g.text));

    let status = 5; // Unknown
    const metaDt = widget.select(".meta dt");
    const metaDd = widget.select(".meta dd");
    
    for (let i = 0; i < metaDt.length; i++) {
        const label = metaDt[i].text;
        const value = metaDd[i].text;
        if (label.includes("Stato")) {
            if (value.toLowerCase().includes("corso")) status = 0; // Ongoing
            else if (value.toLowerCase().includes("finito")) status = 1; // Completed
        }
    }

    // Episodi
    // Logica Kotlin: Cerca in .server[data-name="9"] (Server principale)
    const chapters = [];
    const serverElement = doc.selectFirst(".widget.servers .server[data-name='9']");
    
    if (serverElement) {
        const episodes = serverElement.select(".episode a");
        episodes.forEach(ep => {
            const epNum = ep.attr("data-episode-num");
            const epId = ep.attr("data-id"); // Importante per l'API
            // Salviamo data-id nell'url o usiamo l'url della pagina se necessario
            // Il codice Kotlin usa: "$number¿$actualUrl" nel load e poi fa scraping.
            // Qui passeremo l'URL della pagina e il data-id come parametro custom nell'url interno
            
            // Creiamo un URL virtuale contenente le info necessarie per getVideoList
            const chapterUrl = JSON.stringify({
                episodeId: epId,
                episodeNum: epNum,
                pageUrl: fullUrl
            });

            chapters.push({
                name: `Episodio ${epNum}`,
                url: chapterUrl,
                scanlator: "AnimeWorld"
            });
        });
    }

    // Invertiamo per avere il primo episodio in cima se necessario, o lasciamo così.
    // Solitamente Mangayomi gestisce l'ordine.
    
    return {
        description,
        status,
        genre,
        chapters, // Nota: Mangayomi usa 'chapters' anche per episodi anime
        link: fullUrl
    };
  }

  async getVideoList(url) {
    // Qui url è il JSON stringificato creato in getDetail
    const data = JSON.parse(url);
    const episodeId = data.episodeId;

    // Chiamata API per ottenere il link reale
    // Url: https://www.animeworld.so/api/episode/info?id={id}
    const apiUrl = `${this.source.apiUrl}/api/episode/info?id=${episodeId}`;
    
    // Importante: Referer deve essere la pagina principale di AnimeWorld
    const headers = {
        ...this.getHeaders(),
        "Referer": this.source.baseUrl,
        "X-Requested-With": "XMLHttpRequest"
    };

    const res = await this.client.get(apiUrl, headers);
    const json = JSON.parse(res.body);
    
    const streams = [];

    // Logica Kotlin: if (it.target.contains("listeamed.net")) -> VidguardExtractor
    if (json.target && json.target.includes("listeamed.net")) {
        try {
            // VidGuard Extractor Logic
            const vidRes = await this.client.get(json.target, headers);
            const vidBody = vidRes.body;

            // Cerchiamo lo script offuscato o l'oggetto svg
            // VidGuard usa script con eval(). Dobbiamo estrarre il risultato.
            // Poiché non possiamo usare eval() completo su script packer complessi senza un motore browser,
            // proviamo a cercare se c'è un oggetto JSON esposto o se possiamo usare un regex per "svg".
            
            // Tentativo 1: Simulazione estrazione variabile svg se presente in chiaro o semplice
            // Spesso VidGuard inietta: window.svg = { "stream": "...", "hash": "..." }
            
            // Regex per trovare il contenuto dentro eval() se possibile, o direttamente window.svg
            // Dato che il codice Kotlin usa Rhino per valutare JS, significa che è offuscato (Packer).
            // Tuttavia, se siamo fortunati, possiamo usare QuickJS di Mangayomi.
            
            // Cerchiamo script content
            // Nota: QuickJS supporta eval. Proviamo a isolare il codice.
            const scriptContent = new Document(vidBody).selectFirst("script:containsData(eval)").data;
            
            if (scriptContent) {
                // Prepariamo un contesto minimo per far girare lo script packer
                const context = `
                    var window = {};
                    var document = {};
                    var svg = null;
                    ${scriptContent}
                    // Lo script packer solitamente assegna variabili globali o window.svg
                    // Se lo script assegna a window.svg, lo prendiamo
                    JSON.stringify(window.svg || svg); 
                `;
                
                // Mangayomi/QuickJS eval
                try {
                    const evalResult = eval(context); 
                    const svgObj = JSON.parse(evalResult);
                    
                    if (svgObj && svgObj.stream) {
                        const masterUrl = this.sigDecode(svgObj.stream);
                        
                        streams.push({
                            url: masterUrl,
                            quality: "VidGuard Auto",
                            originalUrl: masterUrl,
                            headers: headers,
                            videoType: "hls" // Solitamente m3u8
                        });
                    }
                } catch(e) {
                    // Fallback se eval fallisce
                    console.log("VidGuard eval failed: " + e.message);
                }
            }
        } catch (e) {
            console.error("Errore VidGuard: " + e.message);
        }
    } else if (json.target && json.target.includes("animeworld")) {
        // Link diretto (raro ma gestito nel kotlin)
        streams.push({
            url: json.grabber, // o json.target, dipende dalla risposta specifica
            quality: "Direct",
            originalUrl: json.grabber,
            headers: headers
        });
    }

    return streams;
  }

  getSourcePreferences() {
    return [
      {
        key: "animeworld_note",
        listPreference: {
          title: "Nota",
          summary: "Questo plugin usa le API di AnimeWorld.so e decodifica VidGuard.",
          valueIndex: 0,
          entries: ["OK"],
          entryValues: ["0"],
        },
      }
    ];
  }
}
