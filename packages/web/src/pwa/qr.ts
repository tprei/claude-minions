import QrScanner from "qr-scanner";

export async function scanQrFromCamera(): Promise<string> {
  const video = document.createElement("video");
  video.setAttribute("playsinline", "true");

  return new Promise<string>((resolve, reject) => {
    const scanner = new QrScanner(
      video,
      result => {
        scanner.stop();
        scanner.destroy();
        resolve(result.data);
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
      }
    );

    scanner.start().catch(err => {
      scanner.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
