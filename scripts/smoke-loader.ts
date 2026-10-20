import { getChapter, getBook, getNotes, getAttribution } from "../src/lib/data.ts";

const ch = await getChapter("MRK", 1);
console.log("greek source:", ch.greek.source, "| english source:", ch.english.source);
console.log(
  "greek verses:",
  ch.greek.verses.map((v) => v.verse + (v.overridden ? "*" : v.addition ? "+" : "")).join(" ")
);
console.log("english 1:4:", ch.english.verses.find((v) => v.verse === 4)?.text);
console.log("rows:", JSON.stringify(ch.rows));
const book = await getBook("MRK");
console.log("book:", book.meta.name, "| chapters on disk:", book.chapters.length);
const notes = await getNotes("MRK");
console.log("note ids:", [...(notes.greek ?? []).map((n) => n.id), ...(notes.english ?? []).map((n) => n.id)].join(", "));
console.log("sblgnt attribution name:", (await getAttribution())?.sources.sblgnt.name);
