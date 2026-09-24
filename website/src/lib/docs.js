import fs from "node:fs";
import path from "node:path";
import { marked, Renderer } from "marked";

const COOK_ROOT = path.resolve(process.cwd(), "..");
const USER_GUIDE_DIR = path.join(
  COOK_ROOT,
  "crates/codegen/xai-grok-pager/docs/user-guide",
);
const sectionByPrefix = [
  ["01-", "Getting started"],
  ["02-", "Getting started"],
  ["03-", "Using Cook"],
  ["14-", "Using Cook"],
  ["15-", "Using Cook"],
  ["04-", "Commands"],
  ["28-", "Commands"],
  ["29-", "Using Cook"],
  ["16-", "Workflows"],
  ["17-", "Workflows"],
  ["19-", "Workflows"],
  ["20-", "Workflows"],
  ["30-", "Workflows"],
  ["05-", "Configure and extend"],
  ["06-", "Configure and extend"],
  ["07-", "Configure and extend"],
  ["08-", "Configure and extend"],
  ["09-", "Configure and extend"],
  ["10-", "Configure and extend"],
  ["11-", "Configure and extend"],
  ["12-", "Configure and extend"],
  ["13-", "Configure and extend"],
  ["18-", "Configure and extend"],
  ["22-", "Configure and extend"],
  ["25-", "Configure and extend"],
  ["26-", "Configure and extend"],
  ["21-", "Reference"],
  ["23-", "Reference"],
  ["24-", "Reference"],
  ["27-", "Reference"],
];

function routeSlug(filename) {
  return filename.replace(/^\d+-/, "").replace(/\.md$/i, "");
}

function plainText(markdown) {
  return markdown
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function guideSummary(markdown, title) {
  const withoutHeading = markdown.replace(/^#\s+.*(?:\r?\n|$)/m, "");
  const paragraph = withoutHeading
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("#") && !part.startsWith("---"));
  const text = plainText(paragraph ?? `Learn about ${title.toLowerCase()} in Cook.`);
  return text.length > 157 ? `${text.slice(0, 154).trimEnd()}…` : text;
}

function sectionFor(filename) {
  return sectionByPrefix.find(([prefix]) => filename.startsWith(prefix))?.[1] ?? "Reference";
}

export function getUserGuides() {
  const userGuideFiles = fs
    .readdirSync(USER_GUIDE_DIR)
    .filter((filename) => /^\d+-.*\.md$/i.test(filename))
    .map((filename) => ({
      file: path.join(USER_GUIDE_DIR, filename),
      filename,
      slug: routeSlug(filename),
      section: sectionFor(filename),
    }));
  return userGuideFiles.map((guide) => {
    const markdown = fs.readFileSync(guide.file, "utf8");
    const title = markdown.match(/^#\s+(.+?)\s*$/m)?.[1] ?? guide.slug;
    return {
      ...guide,
      title,
      summary: guideSummary(markdown, title),
      markdown,
    };
  });
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function slugText(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/[\s-]+/g, "-");
}

export function renderGuide(guide) {
  const allGuides = getUserGuides();
  const routeByFile = new Map(
    allGuides.map((item) => [path.resolve(item.file), item.slug]),
  );
  const slugCounts = new Map();
  const renderer = new Renderer();

  renderer.heading = ({ depth, text }) => {
    const base = slugText(text);
    const count = slugCounts.get(base) ?? 0;
    slugCounts.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    return `<h${depth} id="${escapeAttribute(id)}">${text}</h${depth}>\n`;
  };

  renderer.link = ({ href, title, text }) => {
    let target = href ?? "";
    if (target && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) {
      const [pathname, ...fragmentParts] = target.split("#");
      const targetFile = path.resolve(path.dirname(guide.file), pathname);
      const targetSlug = routeByFile.get(targetFile);
      if (targetSlug) {
        target = `/docs/guides/${targetSlug}/`;
        if (fragmentParts.length) target += `#${fragmentParts.join("#")}`;
      } else if (path.basename(targetFile) === "22-environment-variables.md") {
        target = "/docs/guides/configuration/#environment-variables";
      } else if (/\.md$/i.test(pathname)) {
        const sourcePath = path
          .relative(COOK_ROOT, targetFile)
          .split(path.sep)
          .join("/");
        target = `https://github.com/weseegod/cook/blob/main/${sourcePath}`;
        if (fragmentParts.length) target += `#${fragmentParts.join("#")}`;
      }
    }
    const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : "";
    return `<a href="${escapeAttribute(target)}"${titleAttribute}>${text}</a>`;
  };

  return marked.parse(guide.markdown, { gfm: true, renderer });
}
