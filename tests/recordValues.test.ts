import { describe, expect, it } from "vitest";

import { omitUndefinedFields } from "@/lib/recordValues";

describe("DynamoDB record values", () => {
  it("omits absent optional connection fields instead of persisting undefined", () => {
    expect(omitUndefinedFields({ platform: "instagram", handle: undefined, accountId: "123" }))
      .toEqual({ platform: "instagram", accountId: "123" });
  });

  it("preserves falsey values that DynamoDB can store", () => {
    expect(omitUndefinedFields({ empty: "", zero: 0, disabled: false, absent: undefined }))
      .toEqual({ empty: "", zero: 0, disabled: false });
  });
});
