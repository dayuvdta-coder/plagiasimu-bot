const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyAssignmentAction,
  classifyAssignmentDashboardState,
  classifyClassAction,
} = require("../src/services/turnitin-dom");

test("classifyClassAction derives class name from container text", () => {
  const result = classifyClassAction({
    label: "Open",
    containerText: "English Literature 2026\nOpen",
    containerLines: ["English Literature 2026", "Open"],
  });

  assert.equal(result.name, "English Literature 2026");
});

test("classifyAssignmentAction marks available rows", () => {
  const result = classifyAssignmentAction({
    label: "Open",
    disabled: false,
    containerText: "Assignment 1\nDue tomorrow\nOpen",
    containerLines: ["Assignment 1", "Due tomorrow", "Open"],
  });

  assert.equal(result.name, "Assignment 1");
  assert.equal(result.status, "available");
  assert.equal(result.similarity, null);
});

test("classifyAssignmentAction marks used rows from similarity text", () => {
  const result = classifyAssignmentAction({
    label: "Open",
    disabled: false,
    containerText: "Assignment 2\nSimilarity 18%\nSubmitted",
    containerLines: ["Assignment 2", "Similarity 18%", "Submitted"],
  });

  assert.equal(result.status, "used");
  assert.equal(result.similarity, "18%");
});

test("classifyAssignmentDashboardState marks empty assignment dashboard as available", () => {
  const result = classifyAssignmentDashboardState({
    title: "Assignment Dashboard",
    bodyText:
      "Assignment Dashboard You have no active papers in this assignment. Upload Submission",
    actionLabels: ["Upload Submission"],
  });

  assert.equal(result.status, "available");
  assert.equal(result.similarity, null);
});

test("classifyAssignmentDashboardState marks resubmission dashboard as used", () => {
  const result = classifyAssignmentDashboardState({
    title: "Assignment Dashboard",
    bodyText:
      "Paper Title skripsiku Uploaded 03/07/2026 2:50 PM Similarity 99% Resubmit paper Download digital receipt Confirm Resubmission",
    actionLabels: ["Resubmit paper: skripsiku", "Confirm"],
  });

  assert.equal(result.status, "used");
  assert.equal(result.similarity, "99%");
});
