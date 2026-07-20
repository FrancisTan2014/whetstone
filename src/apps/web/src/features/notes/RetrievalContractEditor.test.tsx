// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTextDocument, documentText, type DocumentNodeJSON } from "@whetstone/document";

import {
  gradingTargetFor,
  isDocumentBlank,
  RetrievalContractEditor,
  type SuccessCheckState
} from "./RetrievalContractEditor";
import { createEmptyDocument } from "../../shared/editor/editorDocument.js";

// The shared editor renders a Tiptap contenteditable in production; here it stands in as a textarea keyed
// by its aria-label so the controlled Question/Success-check fields can be driven and read as plain text.
vi.mock("../../shared/editor/index.js", async () => {
  const React = await import("react");
  const { createTextDocument: make, documentText: read } = await import("@whetstone/document");
  return {
    RichContentEditor: ({
      ariaLabel,
      document,
      onChange
    }: {
      ariaLabel?: string;
      document: unknown;
      onChange: (document: unknown) => void;
    }) =>
      React.createElement("textarea", {
        "aria-label": ariaLabel,
        onChange: (event: { target: { value: string } }) => onChange(make(event.target.value)),
        value: read(document as never)
      })
  };
});

afterEach(cleanup);

// A controlled host that lifts the editor's business state exactly as the real composer does, so each
// interaction (typing, opening the disclosure, previewing) round-trips through props like production.
function Harness({
  answer = "",
  question = "",
  questionInvalid = false,
  successCheck: initialSuccessCheck = { open: false },
  successCheckInvalid = false
}: {
  answer?: string;
  question?: string;
  questionInvalid?: boolean;
  successCheck?: SuccessCheckState;
  successCheckInvalid?: boolean;
} = {}): React.JSX.Element {
  const [answerDoc, setAnswerDoc] = useState<DocumentNodeJSON>(() => createTextDocument(answer));
  const [questionDoc, setQuestionDoc] = useState<DocumentNodeJSON>(() =>
    createTextDocument(question)
  );
  const [successCheck, setSuccessCheck] = useState<SuccessCheckState>(initialSuccessCheck);

  return (
    <RetrievalContractEditor
      actions={
        <button type="button" data-testid="parent-action">
          Create card
        </button>
      }
      onQuestionChange={setQuestionDoc}
      onSuccessCheckChange={setSuccessCheck}
      questionDoc={questionDoc}
      questionInvalid={questionInvalid}
      successCheck={successCheck}
      successCheckInvalid={successCheckInvalid}
      workspace={
        <textarea
          aria-label="Answer"
          onChange={(event) => setAnswerDoc(createTextDocument(event.target.value))}
          value={documentText(answerDoc)}
        />
      }
      workspaceBlank={isDocumentBlank(answerDoc)}
      workspaceDoc={answerDoc}
    />
  );
}

describe("gradingTargetFor", () => {
  it("grades against the current note when the disclosure is closed", () => {
    expect(gradingTargetFor({ open: false })).toEqual({ kind: "current_note" });
  });

  it("grades against the authored success check when the disclosure is open", () => {
    const doc = createTextDocument("Must mention Paris.");
    expect(gradingTargetFor({ doc, open: true })).toEqual({
      kind: "expected_response",
      successCheckDoc: doc
    });
  });
});

describe("isDocumentBlank", () => {
  it("is true for a whitespace-only document", () => {
    expect(isDocumentBlank(createTextDocument("   "))).toBe(true);
    expect(isDocumentBlank(createEmptyDocument())).toBe(true);
  });

  it("is false for a document with readable text", () => {
    expect(isDocumentBlank(createTextDocument("Paris."))).toBe(false);
  });
});

describe("RetrievalContractEditor", () => {
  it("labels the workspace Answer and shows the trigger and guidance", () => {
    render(<Harness />);

    expect(screen.getByRole("heading", { name: "Answer" })).toBeTruthy();
    expect(screen.getByText("What should bring it to mind?")).toBeTruthy();
    expect(screen.getByText(/One target · clear trigger · enough to judge/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a specific success check" })).toBeTruthy();
  });

  it("relabels the workspace Reference and reveals the check when the disclosure opens", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Add a specific success check" }));

    expect(screen.getByRole("heading", { name: "Reference" })).toBeTruthy();
    expect(screen.getByText(/Use this when the whole reference is broader/)).toBeTruthy();
    expect(screen.getByLabelText("Success check")).toBeTruthy();
  });

  it("closes a blank success check silently, with no confirmation", async () => {
    const user = userEvent.setup();
    render(<Harness successCheck={{ doc: createEmptyDocument(), open: true }} />);

    await user.click(screen.getByRole("button", { name: "Remove success check" }));

    expect(screen.queryByText(/Remove the success check you wrote/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Answer" })).toBeTruthy();
  });

  it("confirms before discarding a non-empty success check and can be kept", async () => {
    const user = userEvent.setup();
    render(
      <Harness successCheck={{ doc: createTextDocument("Must mention Paris."), open: true }} />
    );

    await user.click(screen.getByRole("button", { name: "Remove success check" }));
    expect(screen.getByText(/Remove the success check you wrote/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByText(/Remove the success check you wrote/)).toBeNull();
    expect(screen.getByLabelText("Success check")).toBeTruthy();
  });

  it("discards a non-empty success check on confirmation", async () => {
    const user = userEvent.setup();
    render(
      <Harness successCheck={{ doc: createTextDocument("Must mention Paris."), open: true }} />
    );

    await user.click(screen.getByRole("button", { name: "Remove success check" }));
    await user.click(screen.getByRole("button", { name: "Remove it" }));

    expect(screen.getByRole("heading", { name: "Answer" })).toBeTruthy();
    expect(screen.queryByLabelText("Success check")).toBeNull();
  });

  it("surfaces the inline question error when the parent marks it invalid", () => {
    render(<Harness questionInvalid />);

    expect(screen.getByText("Write what should bring it to mind.")).toBeTruthy();
  });

  it("surfaces the inline success-check error when the parent marks it invalid", () => {
    render(
      <Harness successCheck={{ doc: createEmptyDocument(), open: true }} successCheckInvalid />
    );

    expect(screen.getByText("Write the success check, or remove it.")).toBeTruthy();
  });

  it("disables Try until the question and answer are both present", async () => {
    const user = userEvent.setup();
    render(<Harness answer="Paris." />);

    expect(screen.getByRole("button", { name: "Try card" }).hasAttribute("disabled")).toBe(true);

    await user.type(screen.getByLabelText("Question"), "Capital of France?");
    expect(screen.getByRole("button", { name: "Try card" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps Try disabled while an opened success check is blank", () => {
    render(
      <Harness
        answer="Paris."
        question="Capital?"
        successCheck={{ doc: createEmptyDocument(), open: true }}
      />
    );

    expect(screen.getByRole("button", { name: "Try card" }).hasAttribute("disabled")).toBe(true);
  });

  it("rehearses the note reveal in preview without exposing the actions", async () => {
    const user = userEvent.setup();
    render(<Harness answer="Paris is the capital." question="Capital of France?" />);

    await user.click(screen.getByRole("button", { name: "Try card" }));

    expect(screen.getByText(/Preview · nothing is saved/)).toBeTruthy();
    expect(screen.getByText("Capital of France?")).toBeTruthy();
    expect(screen.queryByTestId("parent-action")).toBeNull();
    expect(screen.queryByText("Paris is the capital.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByLabelText("Note")).toBeTruthy();
    expect(screen.getByText("Paris is the capital.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back to editing" }));
    expect(screen.getByLabelText("Question")).toBeTruthy();
    expect(screen.getByTestId("parent-action")).toBeTruthy();
  });

  it("reveals the success check and reference for an expected-response target in preview", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        answer="Paris is the capital of France."
        question="Capital of France?"
        successCheck={{ doc: createTextDocument("Must say Paris."), open: true }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Try card" }));
    await user.click(screen.getByRole("button", { name: "Reveal" }));

    expect(screen.getByLabelText("Success check")).toBeTruthy();
    expect(screen.getByText("Must say Paris.")).toBeTruthy();
    expect(screen.getByLabelText("Reference")).toBeTruthy();
    expect(screen.getByText("Paris is the capital of France.")).toBeTruthy();
  });
});
