// The simulated bash shell every lab runs on: parsing and execution, quoting, and the ~/scratch folder.
// Pure TypeScript, no React.
export * from './scratch';
export * from './shellcore';
export { needsMore, runBashText, runShell, splitBash } from './shell';
