// 16.09.26

/**
 * Raised to stop a download.
 * keepFiles is true when the program is closing: the segments stay, so the download goes on at the next start.
 */
class DownloadCancelled extends Error {
  constructor(keepFiles = false) {
    super('Download annullato');
    this.name = 'DownloadCancelled';
    this.keepFiles = keepFiles;
  }
}

module.exports = { DownloadCancelled };
