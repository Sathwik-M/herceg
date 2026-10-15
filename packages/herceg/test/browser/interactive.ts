// Imported by tests whose charts take input as soon as they are mounted, as
// charts do once one on the page has loaded its interaction controller.
// deferred.test.ts tests the input that arrives before it has.

import { loadInteraction } from "../../src/dom/chart.ts";

await loadInteraction();
