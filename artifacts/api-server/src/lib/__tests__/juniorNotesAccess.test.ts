import { describe, expect, it } from "vitest";
import { canReadJuniorNotes, juniorTeamFilter, type JuniorNotesViewer, type ReviewScope } from "../juniorReview";

// GET /junior-notes, /junior-notes/history?trader=X, /junior-notes/team: the junior themself, their
// mentor / assigned reviewer, or staff (desk review / desk-wide journal.read.team). Guests: nothing.
const none: ReviewScope = { kind: "none" };
const desk: ReviewScope = { kind: "desk", mine: [] };
const mentor: ReviewScope = { kind: "scoped", via: "mentor", traders: ["Закир"], mine: ["Закир"] };
const traderV: JuniorNotesViewer = { me: "Артур", guest: false, teamScope: ["Артур"] };
const mentorV: JuniorNotesViewer = { me: "Умид", guest: false, teamScope: ["Умид"] };
const curatorV: JuniorNotesViewer = { me: "Ориф", guest: false, teamScope: null };
const guestV: JuniorNotesViewer = { me: "Гость", guest: true, teamScope: [] };

describe("canReadJuniorNotes", () => {
  it("a junior reads their own notes", () => {
    expect(canReadJuniorNotes(traderV, none, "Артур")).toBe(true);
  });
  it("a junior may not read another junior's notes", () => {
    expect(canReadJuniorNotes(traderV, none, "Закир")).toBe(false);
  });
  it("a mentor reads their mentees only", () => {
    expect(canReadJuniorNotes(mentorV, mentor, "Закир")).toBe(true);
    expect(canReadJuniorNotes(mentorV, mentor, "Максат")).toBe(false);
  });
  it("staff with desk review or desk-wide team read may read anyone", () => {
    expect(canReadJuniorNotes(curatorV, desk, "Закир")).toBe(true);
    expect(canReadJuniorNotes({ ...curatorV, teamScope: [] }, desk, "Закир")).toBe(true);
    expect(canReadJuniorNotes(curatorV, none, "Закир")).toBe(true);
  });
  it("an assigned-scope reader may read the traders in their team scope only", () => {
    const assignedV: JuniorNotesViewer = { me: "Антон", guest: false, teamScope: ["Антон", "Рахматулло"] };
    expect(canReadJuniorNotes(assignedV, none, "Рахматулло")).toBe(true);
    expect(canReadJuniorNotes(assignedV, none, "Закир")).toBe(false);
  });
  it("guests and empty names never", () => {
    expect(canReadJuniorNotes(guestV, desk, "Закир")).toBe(false);
    expect(canReadJuniorNotes({ ...guestV, me: "Закир" }, desk, "Закир")).toBe(false);
    expect(canReadJuniorNotes(traderV, none, "")).toBe(false);
    expect(canReadJuniorNotes(traderV, none, null)).toBe(false);
  });
});

describe("juniorTeamFilter", () => {
  it("a plain junior sees only their own summary", () => {
    expect(juniorTeamFilter(traderV, none)).toEqual(["Артур"]);
  });
  it("a mentor sees themself plus their mentees", () => {
    expect(juniorTeamFilter(mentorV, mentor)).toEqual(["Закир", "Умид"]);
  });
  it("desk reviewers and desk-wide readers see everyone (null = no filter)", () => {
    expect(juniorTeamFilter(curatorV, desk)).toBeNull();
    expect(juniorTeamFilter({ ...traderV, teamScope: null }, none)).toBeNull();
    expect(juniorTeamFilter(traderV, desk)).toBeNull();
  });
  it("guests see nothing", () => {
    expect(juniorTeamFilter(guestV, desk)).toEqual([]);
  });
});
