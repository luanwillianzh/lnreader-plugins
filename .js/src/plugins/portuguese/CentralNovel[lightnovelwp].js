const { Parser } = require("htmlparser2");
const { fetchApi } = require("@libs/fetch");
const { NovelStatus } = require("@libs/novelStatus");
const { defaultCover } = require("@libs/defaultCover");
const { storage } = require("@libs/storage");

function setChapterNumber(text, chapter) {
  const match = text.match(/(\d+)$/);
  if (match && match[0]) {
    chapter.chapterNumber = parseInt(match[0]);
  }
}

class LightNovelWPPlugin {
  constructor(config) {
    this.hideLocked = storage.get("hideLocked");
    this.id = config.id;
    this.name = config.sourceName;
    this.icon = "multisrc/lightnovelwp/" + config.id.toLowerCase() + "/icon.png";
    this.site = config.sourceSite;

    const versionIncrements = (config.options && config.options.versionIncrements) || 0;
    this.version = "1.1." + (10 + versionIncrements);

    this.options = config.options || {};
    this.filters = config.filters;

    if (this.options.hasLocked) {
      this.pluginSettings = {
        hideLocked: { value: "", label: "Hide locked chapters", type: "Switch" },
      };
    }
  }

  getHostname(url) {
    const domain = url.split("/")[2].split(".");
    domain.pop();
    return domain.join(".");
  }

  async safeFecth(url, allowError) {
    const parts = url.split("://");
    const protocol = parts.shift();
    const target = parts[0].replace(/\/\//g, "/");

    const res = await fetchApi(protocol + "://" + target);
    if (!res.ok && allowError !== 1) {
      throw new Error("Could not reach site (" + res.status + ") try to open in webview.");
    }

    const html = await res.text();

    const title = (html.match(/<title>(.*?)<\/title>/) || [null])[1];
    const cleanTitle = title ? title.trim() : "";
    const isCaptcha =
      cleanTitle === "Bot Verification" ||
      cleanTitle === "You are being redirected..." ||
      cleanTitle === "Un instant..." ||
      cleanTitle === "Just a moment..." ||
      cleanTitle === "Redirecting...";

    if (this.getHostname(url) !== this.getHostname(res.url) || (cleanTitle && isCaptcha)) {
      throw new Error(
        "Captcha error, please open in webview (or the website has changed url)"
      );
    }

    return html;
  }

  parseNovels(html) {
    const novels = [];
    const articles = html.match(/<article([^]*?)<\/article>/g) || [];

    for (const article of articles) {
      const link = article.match(/<a href="([^"]*)".*? title="([^"]*)"/) || [];
      const href = link[1];
      const name = link[2];

      if (!name || !href) continue;

      const img =
        article.match(
          /<img [^>]*?src="([^"]*)"[^>]*?(?: data-src="([^"]*)")?[^>]*>/
        ) || [];

      let path;
      if (href.includes(this.site)) {
        path = href.replace(this.site, "");
      } else {
        const pieces = href.split("/");
        pieces.shift();
        pieces.shift();
        pieces.shift();
        path = pieces.join("/");
      }

      novels.push({
        name: name,
        cover: img[2] || img[1] || defaultCover,
        path: path,
      });
    }

    return novels;
  }

  async popularNovels(page, params) {
    const { filters, showLatestNovels } = params || {};
    const seriesPath = (this.options && this.options.seriesPath) || "/series/";

    let link = this.site + seriesPath + "?page=" + page;
    if (showLatestNovels) link += "&order=latest";

    const activeFilters = filters || this.filters || {};
    for (const key in activeFilters) {
      const filter = activeFilters[key];
      if (typeof filter.value === "object") {
        for (const value of filter.value) {
          link += "&" + key + "=" + value;
        }
      } else if (filter.value) {
        link += "&" + key + "=" + filter.value;
      }
    }

    const html = await this.safeFecth(link, false);
    return this.parseNovels(html);
  }

  async parseNovel(novelUrl) {
    const site = this.site;
    const url = site + novelUrl;
    const html = await this.safeFecth(url, false);

    const novel = {
      path: novelUrl,
      name: "",
      genres: "",
      summary: "",
      author: "",
      artist: "",
      status: "",
      chapters: [],
    };

    const chapters = [];
    let chapter = {};

    let inGenres = false;
    let inGenreLink = false;
    let summaryDepth = 0;
    let inInfo = false;
    let inInfoField = false;
    let isAuthor = false;
    let isArtist = false;
    let isStatus = false;
    let inChapterList = false;
    let inListItem = false;
    let fieldType = 0;
    let isLocked = false;
    let anyLocked = false;

    const hideLocked = this.hideLocked;

    const parser = new Parser({
      onopentag(name, attrs) {
        if (!novel.cover && attrs.class && attrs.class.includes("ts-post-image")) {
          novel.name = attrs.title;
          novel.cover = attrs["data-src"] || attrs.src || defaultCover;
          return;
        }

        if (attrs.class === "genxed" || attrs.class === "sertogenre") {
          inGenres = true;
          return;
        }
        if (inGenres && name === "a") {
          inGenreLink = true;
          return;
        }

        if (
          name === "div" &&
          (attrs.class === "entry-content" || attrs.itemprop === "description")
        ) {
          summaryDepth++;
          return;
        }

        if (attrs.class === "spe" || attrs.class === "serl") {
          inInfo = true;
          return;
        }
        if (inInfo && name === "span") {
          inInfoField = true;
          return;
        }
        if (name === "div" && attrs.class === "sertostat") {
          inInfo = true;
          inInfoField = true;
          isStatus = true;
          return;
        }

        if (attrs.class && attrs.class.includes("eplister")) {
          inChapterList = true;
          return;
        }
        if (inChapterList && name === "li") {
          inListItem = true;
          return;
        }
        if (inListItem) {
          if (name === "a" && chapter.path === undefined) {
            chapter.path = attrs.href.replace(site, "").trim();
          } else if (attrs.class === "epl-num") {
            fieldType = 1;
          } else if (attrs.class === "epl-title") {
            fieldType = 2;
          } else if (attrs.class === "epl-date") {
            fieldType = 3;
          } else if (attrs.class === "epl-price") {
            fieldType = 4;
          }
          return;
        }

        if (summaryDepth !== 0 && (name === "div" || name === "script")) {
          summaryDepth++;
        }
      },

      ontext(text) {
        if (inGenres) {
          if (inGenreLink) novel.genres += text + ", ";
          return;
        }

        if (summaryDepth === 1 && text.trim()) {
          novel.summary += text;
          return;
        }

        if (inInfo) {
          if (inInfoField) {
            const label = text.toLowerCase().replace(":", "").trim();

            if (isAuthor) {
              novel.author += text || "Unknown";
            } else if (isArtist) {
              novel.artist += text || "Unknown";
            } else if (isStatus) {
              switch (label) {
                case "مكتملة":
                case "completed":
                case "complété":
                case "completo":
                case "completado":
                case "tamamlandı":
                  novel.status = NovelStatus.Completed;
                  break;
                case "مستمرة":
                case "ongoing":
                case "en cours":
                case "em andamento":
                case "en progreso":
                case "devam ediyor":
                  novel.status = NovelStatus.Ongoing;
                  break;
                case "متوقفة":
                case "hiatus":
                case "en pause":
                case "hiato":
                case "pausa":
                case "pausado":
                case "duraklatıldı":
                  novel.status = NovelStatus.OnHiatus;
                  break;
                default:
                  novel.status = NovelStatus.Unknown;
              }
            }

            switch (label) {
              case "الكاتب":
              case "author":
              case "auteur":
              case "autor":
              case "yazar":
                isAuthor = true;
                break;
              case "الحالة":
              case "status":
              case "statut":
              case "estado":
              case "durum":
                isStatus = true;
                break;
              case "الفنان":
              case "artist":
              case "artiste":
              case "artista":
              case "çizer":
                isArtist = true;
                break;
            }
          }
          return;
        }

        if (!inChapterList || !inListItem) return;

        if (fieldType === 1) {
          if (text.includes("🔒")) {
            isLocked = true;
            anyLocked = true;
          } else if (anyLocked) {
            isLocked = false;
          }
          setChapterNumber(text, chapter);
        } else if (fieldType === 2) {
          const escaped = novel.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const parsed = text.match(new RegExp("^" + escaped + "\\s*(.+)"));
          const parsedName = parsed ? parsed[1] : null;
          chapter.name = (parsedName ? parsedName.trim() : "") || text.trim();
          if (!chapter.chapterNumber) setChapterNumber(text, chapter);
        } else if (fieldType === 3) {
          chapter.releaseTime = text;
        } else if (fieldType === 4) {
          const price = text.toLowerCase().trim();
          if (
            price === "free" ||
            price === "gratuit" ||
            price === "مجاني" ||
            price === "livre" ||
            price === ""
          ) {
            isLocked = false;
          } else {
            isLocked = true;
          }
        }
      },

      onclosetag(name) {
        if (inGenres) {
          if (inGenreLink) {
            inGenreLink = false;
          } else {
            inGenres = false;
            novel.genres = novel.genres ? novel.genres.slice(0, -2) : novel.genres;
          }
          return;
        }

        if (summaryDepth > 0) {
          if (name === "p") {
            novel.summary += "\n\n";
          } else if (name === "br") {
            novel.summary += "\n";
          } else if (name === "div" || name === "script") {
            summaryDepth--;
          }
          return;
        }

        if (inInfo) {
          if (inInfoField) {
            if (name === "span") {
              inInfoField = false;
              if (isAuthor && novel.author) isAuthor = false;
              else if (isArtist && novel.artist) isArtist = false;
              else if (isStatus && novel.status !== "") isStatus = false;
            }
          } else if (name === "div") {
            inInfo = false;
            novel.author = novel.author ? novel.author.trim() : novel.author;
            novel.artist = novel.artist ? novel.artist.trim() : novel.artist;
          }
          return;
        }

        if (!inChapterList) return;

        if (inListItem) {
          if (fieldType === 1 || fieldType === 2 || fieldType === 3 || fieldType === 4) {
            fieldType = 0;
          } else if (name === "li") {
            inListItem = false;
            if (!chapter.chapterNumber) chapter.chapterNumber = 0;
            if (isLocked) chapter.name = "🔒 " + chapter.name;
            if (!(hideLocked && isLocked)) chapters.push(chapter);
            chapter = {};
          }
        } else if (name === "ul") {
          inChapterList = false;
        }
      },
    });

    parser.write(html);
    parser.end();

    if (chapters.length) {
      if (this.options.reverseChapters) chapters.reverse();
      novel.chapters = chapters;
    }

    novel.summary = novel.summary.trim();
    return novel;
  }

  async parseChapter(chapterUrl) {
    const html = await this.safeFecth(this.site + chapterUrl, false);

    let title = "";
    const h1Tags = html.match(/<h1[^>]*>([^]*?)<\/h1>/g) || [];
    for (const tag of h1Tags) {
      const text = tag.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      if (text && text !== "†") {
        title = text;
        break;
      }
    }

    const content = html.match(
      /<div.*?class="epcontent ([^]*?)<div.*?class="?bottomnav/g
    );
    const paragraphs = content ? content[0].match(/<p[^>]*>([^]*?)<\/p>/g) : null;
    const body = paragraphs ? paragraphs.join("\n") : "";
    return (title ? "<h1>" + title + "</h1>\n\n" : "") + body;
  }

  async searchNovels(query, page) {
    const url = this.site + "page/" + page + "/?s=" + encodeURIComponent(query);
    const html = await this.safeFecth(url, true);
    return this.parseNovels(html);
  }
}

exports.LightNovelWPPlugin = LightNovelWPPlugin;

const plugin = new LightNovelWPPlugin({
  id: "centralnovel",
  sourceSite: "https://centralnovel.com/",
  sourceName: "Central Novel",
  options: { lang: "Portuguese", reverseChapters: true, versionIncrements: 1 },
  filters: {
    "genre[]": {
      type: "Checkbox",
      label: "Gênero",
      value: [],
      options: [
        { label: "Ação", value: "acao" },
        { label: "Action", value: "action" },
        { label: "Adulto", value: "adulto" },
        { label: "Adventure", value: "adventure" },
        { label: "Artes Marciais", value: "artes-marciais" },
        { label: "Aventura", value: "aventura" },
        { label: "Comédia", value: "comedia" },
        { label: "Cotidiano", value: "cotidiano" },
        { label: "Cultivo", value: "cultivo" },
        { label: "Drama", value: "drama" },
        { label: "Ecchi", value: "ecchi" },
        { label: "Escolar", value: "escolar" },
        { label: "Esportes", value: "esportes" },
        { label: "Evolução", value: "evolucao" },
        { label: "Fantasia", value: "fantasia" },
        { label: "Fantasy", value: "fantasy" },
        { label: "Ficção Científica", value: "ficcao-cientifica" },
        { label: "Gender Bender", value: "gender-bender" },
        { label: "Harém", value: "harem" },
        { label: "Histórico", value: "historico" },
        { label: "Isekai", value: "isekai" },
        { label: "Josei", value: "josei" },
        { label: "LitRPG", value: "litrpg" },
        { label: "Magia", value: "magia" },
        { label: "Mecha", value: "mecha" },
        { label: "Medieval", value: "medieval" },
        { label: "Mistério", value: "misterio" },
        { label: "Mitologia", value: "mitologia" },
        { label: "Monstros", value: "monstros" },
        { label: "Pet", value: "pet" },
        { label: "Protagonista Feminina", value: "protagonista-feminina" },
        { label: "Protagonista Maligno", value: "protagonista-maligno" },
        { label: "Psicológico", value: "psicologico" },
        { label: "Psychological", value: "psychological" },
        { label: "Reencarnação", value: "reencarnacao" },
        { label: "Romance", value: "romance" },
        { label: "Seinen", value: "seinen" },
        { label: "Shoujo", value: "shoujo" },
        { label: "Shounen", value: "shounen" },
        { label: "Shounen BL", value: "shounen-bl" },
        { label: "Sistema", value: "sistema" },
        { label: "Sistema de Jogo", value: "sistema-de-jogo" },
        { label: "Slice of Life", value: "slice-of-life" },
        { label: "Sobrenatural", value: "sobrenatural" },
        { label: "Supernatural", value: "supernatural" },
        { label: "Terror", value: "terror" },
        { label: "Tragédia", value: "tragedia" },
        { label: "Transmigração", value: "transmigracao" },
        { label: "Vida Escolar", value: "vida-escolar" },
        { label: "VRMMO", value: "vrmmo" },
        { label: "Wuxia", value: "wuxia" },
        { label: "Xianxia", value: "xianxia" },
        { label: "Xuanhuan", value: "xuanhuan" },
      ],
    },
    "type[]": {
      type: "Checkbox",
      label: "Tipo",
      value: [],
      options: [
        { label: "Light Novel", value: "light-novel" },
        { label: "Novel Chinesa", value: "novel-chinesa" },
        { label: "Novel Coreana", value: "novel-coreana" },
        { label: "Novel Japonesa", value: "novel-japonesa" },
        { label: "Novel Ocidental", value: "novel-ocidental" },
        { label: "Webnovel", value: "webnovel" },
      ],
    },
    status: {
      type: "Picker",
      label: "Status",
      value: "",
      options: [
        { label: "Todos", value: "" },
        { label: "Em andamento", value: "em andamento" },
        { label: "Hiato", value: "hiato" },
        { label: "Completo", value: "completo" },
      ],
    },
    order: {
      type: "Picker",
      label: "Ordenar por",
      value: "",
      options: [
        { label: "Padrão", value: "" },
        { label: "A-Z", value: "title" },
        { label: "Z-A", value: "titlereverse" },
        { label: "Últ. Att", value: "update" },
        { label: "Últ. Add", value: "latest" },
        { label: "Populares", value: "popular" },
        { label: "Avaliação", value: "rating" },
      ],
    },
  },
});

exports.default = plugin;