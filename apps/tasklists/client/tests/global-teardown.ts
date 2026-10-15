import { reportCssCoverage } from "./helpers/css-coverage";

export default async function globalTeardown() {
  reportCssCoverage();
}
