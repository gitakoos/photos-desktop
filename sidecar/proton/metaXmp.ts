/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * Source:  https://github.com/gitakoos/photos-desktop
 * Website: https://www.photosforproton.eu
 *
 * This file is part of Photos for Proton.
 *
 * Photos for Proton is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// Reads and edits the description, rights and creator of an XMP packet, and takes groups of
// properties out of it. The packet is handled as text, so every property it holds that is not
// named here is left exactly as it was. Every scan finds a closing tag or quote with one search
// forward and gives up on it when there is none, so a packet of unclosed tags costs one pass,
// and a packet larger than `XMP_MAX_CHARS` is neither read nor written.

export type XmpText = { description: string | null; copyright: string | null; author: string | null };

/** What to change: a string sets, an empty one takes the property out, a missing key keeps it. */
export type XmpTextChange = { description?: string; copyright?: string; author?: string };

/** The groups of properties to take out. */
export type XmpStrip = { location: boolean; camera: boolean; text: boolean };

const NS_DC = "http://purl.org/dc/elements/1.1/";

/** The largest packet handled: a larger one reads as empty and is never rewritten. */
export const XMP_MAX_CHARS = 4 * 1024 * 1024;

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const codePoint = (n: number, raw: string) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw);

const unescapeXml = (s: string) =>
  s
    .replace(/&#x([0-9a-f]{1,8});/gi, (raw, h: string) => codePoint(parseInt(h, 16), raw))
    .replace(/&#(\d{1,8});/g, (raw, d: string) => codePoint(Number(d), raw))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * Each attribute of `xml` named by the regular expression source `name`, with where it starts
 * (its leading white space included), where its value starts and where its closing quote is.
 */
function* attributes(xml: string, name: string): Generator<{ start: number; value: number; end: number }> {
  const re = new RegExp(`\\s(?:${name})\\s*=\\s*(["'])`, "g");
  const unclosed = new Set<string>();
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const quote = m[1]!;
    if (unclosed.has(quote)) continue;
    const end = xml.indexOf(quote, re.lastIndex);
    if (end < 0) {
      unclosed.add(quote);
      continue;
    }
    let start = m.index;
    while (start > 0 && isSpace(xml.charCodeAt(start - 1))) start--;
    yield { start, value: re.lastIndex, end };
    re.lastIndex = end + 1;
  }
}

/**
 * Each element of `xml` named by the regular expression source `name`: where it starts and
 * ends, and where its content lies (empty for a self-closing one). One with no closing tag is
 * passed over.
 */
function* elements(xml: string, name: string): Generator<{ start: number; end: number; inner: [number, number] }> {
  const re = new RegExp(`<(${name})(\\s[^<>]*)?\\/?>`, "g");
  const unclosed = new Set<string>();
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const open = re.lastIndex;
    if (m[0].endsWith("/>")) {
      yield { start: m.index, end: open, inner: [open, open] };
      continue;
    }
    const tag = m[1]!;
    if (unclosed.has(tag)) continue;
    const close = xml.indexOf(`</${tag}>`, open);
    if (close < 0) {
      unclosed.add(tag);
      continue;
    }
    const end = close + tag.length + 3;
    yield { start: m.index, end, inner: [open, close] };
    re.lastIndex = end;
  }
}

/** The text of a property in any of its forms: an attribute, a plain element, or a language or sequence list. */
function readProp(xml: string, name: string): string | null {
  for (const a of attributes(xml, name)) return unescapeXml(xml.slice(a.value, a.end)).trim() || null;
  let inner: string | null = null;
  for (const el of elements(xml, name)) {
    if (el.inner[1] === el.inner[0] && el.end === el.inner[1]) continue;
    inner = xml.slice(el.inner[0], el.inner[1]);
    break;
  }
  if (inner === null) return null;
  const items = [...elements(inner, "rdf:li")].map((li) => ({ head: inner.slice(li.start, li.inner[0]), text: inner.slice(li.inner[0], li.inner[1]) }));
  const pick = items.find((i) => /xml:lang\s*=\s*["']x-default["']/.test(i.head)) ?? items[0];
  const raw = pick ? pick.text : inner;
  return unescapeXml(raw.replace(/<[^<>]*>/g, "")).trim() || null;
}

/** The description, rights and creator an XMP packet holds. */
export function readXmpText(xml: string): XmpText {
  if (xml.length > XMP_MAX_CHARS) return { description: null, copyright: null, author: null };
  return { description: readProp(xml, "dc:description"), copyright: readProp(xml, "dc:rights"), author: readProp(xml, "dc:creator") };
}

/** `xml` with the ranges of `cut` taken out; the ranges are in order and do not overlap. */
function cutOut(xml: string, cut: Iterable<{ start: number; end: number }>): string {
  const parts: string[] = [];
  let from = 0;
  for (const c of cut) {
    parts.push(xml.slice(from, c.start));
    from = c.end;
  }
  parts.push(xml.slice(from));
  return parts.join("");
}

/** `xml` without the properties whose names match any of `names` (regular expression sources), in every form. */
function removeProps(xml: string, names: readonly string[]): string {
  let out = xml;
  for (const name of names) {
    out = cutOut(out, [...attributes(out, name)].map((a) => ({ start: a.start, end: a.end + 1 })));
    out = cutOut(out, elements(out, name));
  }
  return out;
}

const DESCRIPTION_TAG = /<rdf:Description\b[^<>]*?(\/?)>/;

/** The properties to add, as the children of one rdf:Description. */
function propsXml(change: XmpTextChange): string {
  let out = "";
  if (change.description) {
    out += `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(change.description)}</rdf:li></rdf:Alt></dc:description>`;
  }
  if (change.copyright) {
    out += `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(change.copyright)}</rdf:li></rdf:Alt></dc:rights>`;
  }
  if (change.author) out += `<dc:creator><rdf:Seq><rdf:li>${escapeXml(change.author)}</rdf:li></rdf:Seq></dc:creator>`;
  return out;
}

const PROP_NAMES: Record<keyof XmpTextChange, string> = {
  description: "dc:description",
  copyright: "dc:rights",
  author: "dc:creator",
};

/** A fresh packet carrying `change`, or null when it has nothing to carry. */
export function newXmpPacket(change: XmpTextChange): string | null {
  const props = propsXml(change);
  if (!props) return null;
  return (
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about="" xmlns:dc="${NS_DC}">${props}</rdf:Description>` +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
  );
}

/**
 * `xml` with `change` applied. Null when the packet has no rdf:Description to put a property
 * in, so a packet this cannot read is never replaced.
 */
export function setXmpText(xml: string, change: XmpTextChange): string | null {
  if (xml.length > XMP_MAX_CHARS) return null;
  const names = (Object.keys(PROP_NAMES) as (keyof XmpTextChange)[]).filter((k) => change[k] !== undefined).map((k) => PROP_NAMES[k]);
  if (names.length === 0) return xml;
  const cleared = removeProps(xml, names);
  const props = propsXml(change);
  if (!props) return cleared;
  const m = DESCRIPTION_TAG.exec(cleared);
  if (!m) return null;
  const declared = /xmlns:dc\s*=/.test(cleared) ? "" : ` xmlns:dc="${NS_DC}"`;
  const open = m[0].replace(/\s*\/?>$/, "") + declared + ">";
  const at = m.index;
  const tail = cleared.slice(at + m[0].length);
  return cleared.slice(0, at) + open + props + (m[1] === "/" ? "</rdf:Description>" : "") + tail;
}

const ALWAYS = ["xmpMM:History", "xmpMM:DerivedFrom", "xmpMM:Pantry", "photoshop:History", "xmp:Thumbnails"];
const LOCATION = [
  "exif:GPS\\w+",
  "photoshop:(?:City|State|Country|Location)",
  "Iptc4xmpCore:(?:Location|CountryCode)",
  "Iptc4xmpExt:(?:LocationShown|LocationCreated|Sublocation)",
];
const CAMERA = [
  "tiff:(?:Make|Model|Software|HostComputer)",
  "tiff:Artist",
  "exif:(?:BodySerialNumber|SerialNumber|LensModel|LensMake|LensSerialNumber|LensSpecification|LensInfo|CameraOwnerName|ImageUniqueID|MakerNote)",
  "exifEX:(?:BodySerialNumber|CameraOwnerName|LensMake|LensModel|LensSerialNumber|LensSpecification)",
  "aux:\\w+",
  "xmp:CreatorTool",
  "xmpMM:(?:InstanceID|DocumentID|OriginalDocumentID)",
];
const TEXT = [
  "dc:(?:description|rights|creator|title|subject|contributor|publisher)",
  "xmpRights:\\w+",
  "photoshop:(?:Credit|Source|Headline|Instructions|CaptionWriter|AuthorsPosition)",
  "tiff:(?:Artist|Copyright|ImageDescription)",
  "Iptc4xmpCore:CreatorContactInfo",
];

/** `xml` without the history, thumbnails and the groups `groups` names, or null for a packet too large to handle. */
export function stripXmp(xml: string, groups: XmpStrip): string | null {
  if (xml.length > XMP_MAX_CHARS) return null;
  const names = [...ALWAYS, ...(groups.location ? LOCATION : []), ...(groups.camera ? CAMERA : []), ...(groups.text ? TEXT : [])];
  return removeProps(xml, names);
}
