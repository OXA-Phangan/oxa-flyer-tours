"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { compressImageFile } from "@/lib/image-compression";
import { generateToken } from "@/lib/token";

type UploadState = "idle" | "uploading" | "done" | "error";

const inputClass =
  "block w-full min-w-0 appearance-none rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-base text-[#201E1B] min-h-[50px] focus:border-[#201E1B] focus:outline-none";
const labelClass = "mb-1.5 block text-sm font-medium text-[#201E1B]";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [checkInDate, setCheckInDate] = useState("");
  const [checkInTime, setCheckInTime] = useState("");
  const [checkOutDate, setCheckOutDate] = useState("");
  const [checkOutTime, setCheckOutTime] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [passportPhotoPath, setPassportPhotoPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedName, setSubmittedName] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // One token per form session — retaking the photo overwrites the same
  // path instead of leaving orphaned uploads behind.
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const datesInvalid = checkInDate !== "" && checkOutDate !== "" && checkOutDate < checkInDate;

  const canSubmit =
    name.trim() !== "" &&
    checkInDate !== "" &&
    checkOutDate !== "" &&
    !datesInvalid &&
    uploadState === "done" &&
    passportPhotoPath !== null &&
    termsAccepted &&
    !submitting;

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so selecting the same file again still fires onChange.
    e.target.value = "";
    if (!file) return;

    setError(null);
    setUploadState("uploading");
    setPassportPhotoPath(null);

    try {
      const compressed = await compressImageFile(file);
      tokenRef.current ??= generateToken();
      const path = `flyerPassports/${tokenRef.current}/passport.jpg`;
      await uploadBytes(ref(storage, path), compressed, {
        contentType: compressed.type || "image/jpeg",
      });
      setPreviewUrl(URL.createObjectURL(compressed));
      setPassportPhotoPath(path);
      setUploadState("done");
    } catch (err) {
      console.error("[register] passport upload failed:", err);
      setUploadState("error");
      setError("Passport photo upload failed. Please check your connection and try again.");
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !passportPhotoPath) return;

    setSubmitting(true);
    setError(null);
    const trimmedName = name.trim();

    try {
      await addDoc(collection(db, "flyerRegistrations"), {
        name: trimmedName,
        checkInDate,
        checkInTime: checkInTime || null,
        checkOutDate,
        checkOutTime: checkOutTime || null,
        passportPhotoPath,
        termsAcceptedAt: serverTimestamp(),
        // The deposit notice sits directly above the terms checkbox, so
        // accepting the terms also acknowledges the deposit.
        depositAcknowledged: true,
        status: "pending",
        submittedAt: serverTimestamp(),
        reviewedAt: null,
        reviewedBy: null,
      });
      setSubmittedName(trimmedName);
    } catch (err) {
      console.error("[register] registration write failed:", err);
      setError("Something went wrong while submitting your registration. Please try again — your details are still filled in.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submittedName !== null) {
    return (
      <main className="flex min-h-screen flex-1 items-center justify-center bg-[#EFEDE7] px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-[#E2DFD6] bg-white p-6 text-center text-[#201E1B]">
          <div className="mb-3 text-4xl">🎉</div>
          <h1 className="mb-3 text-2xl font-semibold">Thanks, {submittedName}!</h1>
          <p className="text-base leading-relaxed text-[#5C5850]">
            Your registration is being reviewed by the OXA team. You&apos;ll receive your personal Flyer Tours link
            via WhatsApp once it&apos;s approved.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-1 justify-center bg-[#EFEDE7] px-4 py-8 text-[#201E1B]">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-2xl font-semibold">Flyer Volunteer Registration</h1>
        <p className="mb-6 text-sm text-[#5C5850]">OXA Flyer Tours — sign up for your stay.</p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-4 rounded-2xl border border-[#E2DFD6] bg-white p-4">
            <div>
              <label htmlFor="name" className={labelClass}>
                Full name
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
              />
            </div>

            {/* Date/time fields stacked vertically on purpose: side-by-side
                native date/time inputs overflow the viewport on iOS. */}
            <div>
              <label htmlFor="checkInDate" className={labelClass}>
                Check-in date
              </label>
              <input
                id="checkInDate"
                type="date"
                required
                value={checkInDate}
                onChange={(e) => setCheckInDate(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="checkInTime" className={labelClass}>
                Check-in time <span className="font-normal text-[#8A857A]">(optional)</span>
              </label>
              <input
                id="checkInTime"
                type="time"
                value={checkInTime}
                onChange={(e) => setCheckInTime(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="checkOutDate" className={labelClass}>
                Check-out date
              </label>
              <input
                id="checkOutDate"
                type="date"
                required
                min={checkInDate || undefined}
                value={checkOutDate}
                onChange={(e) => setCheckOutDate(e.target.value)}
                className={inputClass}
              />
              {datesInvalid && (
                <p className="mt-1.5 text-sm text-red-700">Check-out can&apos;t be before check-in.</p>
              )}
            </div>
            <div>
              <label htmlFor="checkOutTime" className={labelClass}>
                Check-out time <span className="font-normal text-[#8A857A]">(optional)</span>
              </label>
              <input
                id="checkOutTime"
                type="time"
                value={checkOutTime}
                onChange={(e) => setCheckOutTime(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-[#E2DFD6] bg-white p-4">
            <span className={labelClass}>Passport photo</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              className="hidden"
            />
            {uploadState === "done" ? (
              <div className="rounded-xl border border-green-600 bg-green-50 p-3 text-green-800">
                <div className="flex items-center gap-3">
                  {previewUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewUrl} alt="Passport preview" className="h-14 w-14 rounded-lg object-cover" />
                  )}
                  <div className="flex-1 font-medium">✓ Passport Uploaded</div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-lg px-2 py-1 text-sm underline"
                  >
                    Retake
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={uploadState === "uploading"}
                onClick={() => fileInputRef.current?.click()}
                className="w-full rounded-xl border border-dashed border-[#D6D1C3] bg-[#FBF9F4] px-4 py-4 text-base font-medium disabled:opacity-60"
              >
                {uploadState === "uploading" ? "Uploading…" : "📷 Take / choose passport photo"}
              </button>
            )}
          </div>

          <div className="rounded-2xl border-2 border-[#D6D1C3] bg-[#FBF9F4] p-4 text-base">
            🔒 A refundable deposit of ฿1,000 is required in cash at check-in.
          </div>

          <label className="flex items-start gap-3 text-base">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="mt-1 h-5 w-5 shrink-0 accent-[#201E1B]"
            />
            <span>
              I have read and agree to the{" "}
              <button type="button" onClick={() => setTermsOpen(true)} className="font-medium underline">
                Volunteer Terms &amp; Conditions
              </button>
              .
            </span>
          </label>

          {error && (
            <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-2xl bg-[#201E1B] px-4 py-4 text-base font-semibold text-white disabled:opacity-40"
          >
            {submitting ? "Submitting…" : "Submit registration"}
          </button>
        </form>
      </div>

      {termsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          onClick={() => setTermsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="terms-title"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-6 text-[#201E1B] sm:rounded-2xl"
          >
            <h2 id="terms-title" className="mb-3 text-lg font-semibold">
              Volunteer Terms &amp; Conditions
            </h2>
            <p className="mb-6 text-base leading-relaxed text-[#5C5850]">
              Placeholder text — replace with your actual terms. Typically covers: volunteer expectations, the ฿1,000
              deposit and its refund conditions, conduct while flyering, and liability while using a rented scooter.
            </p>
            <button
              type="button"
              onClick={() => setTermsOpen(false)}
              className="w-full rounded-2xl bg-[#201E1B] px-4 py-3 text-base font-semibold text-white"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
