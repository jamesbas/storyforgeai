import { splitSentences } from "@/lib/agents/media-prompt-spec";
import { othersInFrame } from "@/lib/agents/wardrobe";
import { statedHeadcount } from "@/lib/media/seam";
import type { Character } from "@/lib/schemas/character";
import type { SceneDraft } from "@/lib/schemas/storyboard";

export type FrameParticipants = { names: string[]; people: number };
export type FrameParticipantPair = { start: FrameParticipants; end: FrameParticipants };

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  another: 2, second: 2, third: 3, fourth: 4, fifth: 5,
};
const GROUP =
  /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|another|second|third|fourth|fifth|\d+)\s+((?:[\p{L}-]+\s+){0,3}?)(man|men|woman|women|people|persons?|boys?|girls?|friends?|guards?|workers?|crew members?|assistants?|dancers?|bartenders?|guides?|guests?|waiters?|hosts?)\b/giu;
const ENTERS = /\b(?:enters?|arrives?|steps? into (?:the )?frame|walks? into (?:the )?(?:room|frame|shot))\b/i;
const LEAVES = /\b(?:exits?|leaves? (?:the )?(?:room|frame|shot|scene)|walks? out|steps? out|moves? out of frame)\b/i;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionsParticipant(text: string, name: string): boolean {
  return Object.keys(othersInFrame(text, { [name]: "" })).length > 0;
}

type Group = {
  label: string; count: number; kind: string;
  before: string; after: string; ordinal: boolean;
};

function groupsIn(text: string): Group[] {
  const groups = new Map<string, Group>();
  for (const sentence of splitSentences(text)) {
    for (const match of sentence.matchAll(GROUP)) {
      // Do not read "one person beside two men" as one group of men.
      if (/\b(?:and|with|beside|behind|near|of|in|on|at|one|two|three|\d+)\b/i.test(match[2])) continue;
      const count = Math.max(
        NUMBERS[match[1].toLowerCase()] ?? Number(match[1]),
        ...match[2].trim().toLowerCase().split(/\s+/).map((word) => NUMBERS[word] ?? 0),
      );
      if (!Number.isSafeInteger(count) || count < 1) continue;
      const kind = match[3].toLowerCase().replace(/^persons?$/, "people")
        .replace(/^man$/, "men").replace(/^woman$/, "women");
      const group = {
        label: match[0], count, kind,
        before: sentence.slice(0, match.index),
        after: sentence.slice(match.index + match[0].length),
        ordinal: /\b(?:another|second|third|fourth|fifth)\b/i.test(match[0]),
      };
      if (count > (groups.get(kind)?.count ?? 0)) groups.set(kind, group);
    }
  }
  return [...groups.values()];
}

function population(
  text: string,
  names: readonly string[],
  descriptions: ReadonlyMap<string, string>,
): number {
  const explicit = statedHeadcount(text);
  if (explicit !== null) return Math.max(names.length, explicit);
  let total = names.length;
  for (const group of groupsIn(text)) {
    if (/^(?:people|friends?)$/.test(group.kind) &&
        !/\b(?:and|beside|behind|with|near)\s*$/i.test(group.before)) {
      total = Math.max(total, group.count);
      continue;
    }
    const represented = names.filter((name) => {
      const apposition = new RegExp(
        `\\b${escaped(name)}(?:\\s*,|\\s+(?:is|as))\\s*$`, "i",
      ).test(group.before);
      const list = group.after.match(/^(?:\s*[,:(]\s*|\s+(?:named|called|including)\s+)([^,.;:!?]+)/i)?.[1];
      if (apposition || (list && mentionsParticipant(list, name))) return true;
      if (!group.ordinal) return false;
      const description = descriptions.get(name.toLowerCase()) ?? "";
      if (group.kind === "men" || /^boys?$/.test(group.kind)) {
        return /\b(?:man|male|boy)\b/i.test(description);
      }
      if (group.kind === "women" || /^girls?$/.test(group.kind)) {
        return /\b(?:woman|female|girl)\b/i.test(description);
      }
      return mentionsParticipant(description, group.kind.replace(/s$/, ""));
    }).length;
    total += Math.max(0, group.count - represented);
  }
  return total;
}

function changesPopulation(action: string, label: string, pattern: RegExp): boolean {
  const words = label.replace(/^(?:the\s+)?(?:one|two|three|four|five|six|\d+)\s+/i, "")
    .replace(/^(?:the|a|an)\s+/i, "");
  const subject = new RegExp(
    `\\b${escaped(words)}\\s+(?:(?:slowly|quietly|quickly|then)\\s+)?(.+)`, "i",
  );
  return splitSentences(action).some((sentence) => {
    const after = sentence.match(subject)?.[1];
    return after !== undefined && pattern.test(after.split(/[,;]|\band\b/i)[0]);
  });
}

/** Recovered from existing cards and bibles, so a prompt-only rewrite can use it. */
export function sceneFrameParticipants(
  scene: SceneDraft,
  cast: readonly Character[],
  bible: readonly { name: string; description: string }[] = [],
  supportingLabels: readonly string[] = [],
  inheritedOpening?: string,
): FrameParticipantPair {
  const text = `${scene.visualDescription} ${scene.actionDescription}`;
  const descriptions = new Map(
    [...bible, ...cast].map((person) => [person.name.toLowerCase(), person.description]),
  );
  const candidates = [
    ...cast.map((person) => person.name),
    ...[...(scene.charactersPresent ?? []), ...bible.map((person) => person.name), ...supportingLabels]
      .filter((name) => mentionsParticipant(text, name)),
  ];
  const names = [...new Map(candidates.map((name) => [name.trim().toLowerCase(), name.trim()]))
    .values()].filter(Boolean);
  // A wardrobe/bible entry may itself label a numbered group, not one person.
  const groups = groupsIn(text);
  const individuals = names.filter((name) =>
    groupsIn(name).length === 0 && !groups.some((group) => mentionsParticipant(group.label, name)),
  );
  const people = population(text, individuals, descriptions);
  const forFrame = (frame: "start" | "end"): FrameParticipants => {
    const changing = frame === "start" ? ENTERS : LEAVES;
    const excluded = individuals.filter((name) =>
      new RegExp(
        `\\b${escaped(name)}\\s+(?:is|remains|stays)\\s+(?:off[- ]?screen|out of (?:the )?frame)\\b`, "i",
      ).test(scene.visualDescription) || changesPopulation(scene.actionDescription, name, changing),
    );
    const excludedGroups = groups.filter((group) => changesPopulation(scene.actionDescription, group.kind, changing));
    return {
      names: individuals.filter((name) => !excluded.includes(name)),
      people: Math.max(0, people - excluded.length - excludedGroups.reduce((sum, group) => sum + group.count, 0)),
    };
  };
  return {
    start: inheritedOpening === undefined ? forFrame("start") : {
      names: individuals.filter((name) => mentionsParticipant(inheritedOpening, name)),
      people: statedHeadcount(inheritedOpening) ?? 0,
    },
    end: forFrame("end"),
  };
}

/** Only explicit, owner-bound contradictions; this is not a physics simulator. */
export function physicalContradictions(text: string, names: readonly string[]): ("pose_conflict" | "limb_conflict")[] {
  const codes = new Set<"pose_conflict" | "limb_conflict">();
  for (const name of names) {
    const poses = new Set(
      [...text.matchAll(new RegExp(
        `\\b${escaped(name)}\\s+(?:is\\s+)?(stands?|standing|sits?|sitting|kneels?|kneeling|lies|lying)\\b`, "gi",
      ))].map((match) => {
        const pose = match[1].toLowerCase();
        return /^sta/.test(pose) ? "standing" : /^sit/.test(pose) ? "sitting" : /^kne/.test(pose) ? "kneeling" : "lying";
      }),
    );
    if (poses.has("standing") && poses.size > 1) codes.add("pose_conflict");
  }
  if (!names.length) return [...codes];
  const limbs = new Map<string, Set<string>>();
  let last: { owner: string; side: string; part: string } | undefined;
  const owners = names.map(escaped).sort((a, b) => b.length - a.length).join("|");
  const pattern = new RegExp(
    `\\b((?:${owners})['’]s|the same)\\s+(left|right)\\s+(hand|arm|leg|foot|wrist)\\s+([^.!?;]+)`, "giu",
  );
  for (const match of text.matchAll(pattern)) {
    const same = match[1].toLowerCase() === "the same";
    const owner = same ? last?.owner : match[1].slice(0, -2).toLowerCase();
    const side = match[2].toLowerCase();
    const part = match[3].toLowerCase();
    if (!owner || (same && (last?.side !== side || last.part !== part))) continue;
    last = { owner, side, part };
    const state = match[4].toLowerCase();
    const states = limbs.get(`${owner}:${side}:${part}`) ?? new Set<string>();
    if (/^(?:is |rests? )?(?:completely )?free\b/.test(state)) states.add("free");
    if (/^(?:is )?(?:bound|tied|restrained)\b/.test(state)) states.add("bound");
    if (/^(?:is )?(?:(?:completely )?(?:empty|unoccupied)|free of objects)\b/.test(state)) states.add("empty");
    if (/^(?:holds?|grips?|grasps?)\b/.test(state)) states.add("holding");
    if ((states.has("free") && states.has("bound")) ||
        (states.has("empty") && states.has("holding"))) codes.add("limb_conflict");
    limbs.set(`${owner}:${side}:${part}`, states);
  }
  return [...codes];
}
