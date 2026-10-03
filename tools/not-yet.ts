// Placeholder for suites that don't exist yet. It fails, so "nothing ran" never looks green (07).
const suites: Record<string, string> = {
  viewer: "test:viewer: the Playwright viewer suite lands in M2.7. Nothing ran.",
};

const suite = process.argv[2] ?? "";
console.error(suites[suite] ?? `unknown suite "${suite}". Nothing ran.`);
process.exitCode = 1;
