// Placeholder for suites that don't exist yet. It fails, so "nothing ran" never looks green (07).
const suites: Record<string, string> = {
  simulation: "test:simulation: the local pipeline simulation lands in M2.4. Nothing ran.",
  viewer: "test:viewer: the Playwright viewer suite lands in M2.7. Nothing ran.",
};

const suite = process.argv[2] ?? "";
console.error(suites[suite] ?? `unknown suite "${suite}". Nothing ran.`);
process.exitCode = 1;
