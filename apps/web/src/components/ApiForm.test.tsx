import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import {
  ApiForm,
  completeSuccessfulSubmission,
  submissionIsConfirmed,
  runApiRequest,
  serializeApiFormBody,
} from "./ApiForm";
import { ACT_KIND_OPTIONS, VENUE_KIND_OPTIONS } from "@/lib/labels";

describe("ApiForm fields", () => {
  it("passes required through to textareas", () => {
    const html = renderToStaticMarkup(
      <ApiForm
        endpoint="/api/example"
        submitLabel="Send"
        fields={[
          { name: "body", label: "Message", type: "textarea", required: true },
        ]}
      />,
    );

    expect(html).toMatch(/<textarea[^>]*required=""/);
  });

  it("labels the shared `other` value in its form-specific context", () => {
    expect(
      ACT_KIND_OPTIONS.find((option) => option.value === "other"),
    ).toEqual({ value: "other", label: "Other act" });
    expect(
      VENUE_KIND_OPTIONS.find((option) => option.value === "other"),
    ).toEqual({ value: "other", label: "Other venue" });

    const html = renderToStaticMarkup(
      <ApiForm
        endpoint="/api/issues"
        submitLabel="Save"
        fields={[{ name: "category", label: "Issue", type: "select", options: ["other"] }]}
      />,
    );
    expect(html).toContain(">Other</option>");
    expect(html).not.toContain("Other venue");
  });

  it("serializes each configured blank deliberately while create-style blanks stay omitted", () => {
    const values = new Map<string, string>([
      ["bio", "   "],
      ["rateMinCents", ""],
      ["rateMaxCents", "125.50"],
      ["genreTags", ""],
      ["setLengthsMinutes", ""],
      ["optionalCreateField", ""],
    ]);
    const form = {
      get: (name: string) => values.get(name) ?? null,
    };
    const body = serializeApiFormBody({
      fields: [
        { name: "bio", label: "Bio", emptyValue: "empty-string" },
        { name: "rateMinCents", label: "Minimum rate", type: "number", emptyValue: "null" },
        { name: "rateMaxCents", label: "Maximum rate", type: "number", emptyValue: "null" },
        { name: "genreTags", label: "Genres", emptyValue: "empty-array" },
        { name: "setLengthsMinutes", label: "Set lengths", emptyValue: "empty-array" },
        { name: "optionalCreateField", label: "Optional" },
      ],
      form,
      extra: { keep: true },
      transform: "performerProfile",
    });
    expect(body).toEqual({
      keep: true,
      bio: "",
      rateMinCents: null,
      rateMaxCents: 12_550,
      genreTags: [],
      setLengthsMinutes: [],
    });
    expect(body.optionalCreateField).toBeUndefined();
  });

  it("requires an explicit confirmation only when configured", () => {
    const confirmImpl = vi.fn().mockReturnValue(false);

    expect(
      submissionIsConfirmed("Confirm this adjustment", confirmImpl),
    ).toBe(false);
    expect(confirmImpl).toHaveBeenCalledWith("Confirm this adjustment");

    expect(submissionIsConfirmed(undefined, confirmImpl)).toBe(true);
    expect(confirmImpl).toHaveBeenCalledTimes(1);
  });

  it("resets a successful form and returns durable success feedback", () => {
    const reset = vi.fn();
    const success = completeSuccessfulSubmission(
      { reset },
      true,
      "Adjustment submitted.",
    );

    expect(reset).toHaveBeenCalledOnce();
    expect(success).toBe("Adjustment submitted.");

    const noMessage = completeSuccessfulSubmission({ reset }, false, undefined);
    expect(reset).toHaveBeenCalledOnce();
    expect(noMessage).toBeNull();
  });

  it("clears busy after a rejected request so the same operation can retry", async () => {
    const operationBody = JSON.stringify({
      idempotencyKey: "fixed-operation-key",
      amountCents: 2500,
    });
    const request = vi.fn(
      async (_url: string, _init: { body: string }) => ({
        ok: true,
        json: async () => ({}),
      }),
    );
    request.mockRejectedValueOnce(new TypeError("offline"));
    const onBusy = vi.fn();
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const submit = () =>
      runApiRequest({
        request: () =>
          request("/api/admin/bookings/example/adjust", {
            body: operationBody,
          }),
        onBusy,
        onError,
        onSuccess,
      });

    await expect(submit()).resolves.toBe(false);
    expect(onBusy.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
    expect(onError).toHaveBeenLastCalledWith(
      "Could not reach EightGig. Check your connection and try again.",
    );
    expect(onSuccess).not.toHaveBeenCalled();

    await expect(submit()).resolves.toBe(true);
    expect(onBusy.mock.calls.map(([busy]) => busy)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(request.mock.calls.map(([, init]) => init.body)).toEqual([
      operationBody,
      operationBody,
    ]);
    expect(onError).toHaveBeenLastCalledWith(null);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it.each(["ActionButton", "RedirectButton"])(
    "%s clears busy and exposes a readable network error before retry",
    async () => {
      const request = vi.fn(async () => ({
        ok: true,
        json: async () => ({}),
      }));
      request.mockRejectedValueOnce(new TypeError("offline"));
      const onBusy = vi.fn();
      const onError = vi.fn();
      const onSuccess = vi.fn();
      const submit = () =>
        runApiRequest({
          request,
          onBusy,
          onError,
          onSuccess,
        });

      await expect(submit()).resolves.toBe(false);
      expect(onBusy).toHaveBeenNthCalledWith(1, true);
      expect(onBusy).toHaveBeenNthCalledWith(2, false);
      expect(onError).toHaveBeenLastCalledWith(
        "Could not reach EightGig. Check your connection and try again.",
      );

      await expect(submit()).resolves.toBe(true);
      expect(request).toHaveBeenCalledTimes(2);
      expect(onBusy).toHaveBeenLastCalledWith(false);
      expect(onSuccess).toHaveBeenCalledOnce();
    },
  );
});
