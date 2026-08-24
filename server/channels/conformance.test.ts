import { describeChannelConnectorConformance } from "../testing/channel-conformance.ts";
import { createFakeChannelConnector } from "./fake.ts";

let seq = 0;

describeChannelConnectorConformance("fake", () => ({
  connector: createFakeChannelConnector({
    id: `fake-conformance-${++seq}`,
    clock: { now: () => 1_700_000_000_000 },
  }),
}));
