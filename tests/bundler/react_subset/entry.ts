import { run, runPagesRouter, runServerSideProps } from "./view";

run();
await runServerSideProps();
await runPagesRouter();
