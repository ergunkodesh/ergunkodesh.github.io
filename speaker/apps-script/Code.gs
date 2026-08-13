/**
 * Anchor Falls Church — Speaker Submission Portal (Apps Script backend)
 *
 * Paste this into the existing "Speaker Submission" Apps Script project
 * (or a new one), then deploy as a Web App:
 *   - Execute as: Me (serviceexperience@anchorfalls.org recommended)
 *   - Who has access: Anyone
 *
 * SETUP — Project Settings → Script properties (do not hardcode secrets):
 *   SCRIPT_PASSWORD   = shared secret matching speaker/config.js scriptPassword
 *   PARENT_FOLDER_ID  = Drive folder for submissions (e.g. Speaker Submissions)
 *   SHEET_ID          = Spreadsheet ID for the submission log
 *   NOTIFY_EMAILS     = comma-separated recipients (church addresses only)
 *   ERROR_EMAILS      = comma-separated error recipients (optional; defaults to NOTIFY_EMAILS)
 *   GEMINI_API_KEY    = optional; scripture assist only — never blocks speaker ACK
 *   WEB_APP_URL       = optional; this deployment's /exec URL. When set, doPost
 *                       kick-starts processSubmission via a short-timeout self-call
 *                       (faster than waiting for the one-shot time trigger alone).
 *
 * Also enable Advanced Google services if not already:
 *   - Drive API
 *   - Google Slides API
 *
 * After deploy: put the /exec URL into speaker/config.js as googleScriptUrl,
 * rotate SCRIPT_PASSWORD (old HTML passwords are public), optionally set
 * WEB_APP_URL to the same /exec URL, and test once.
 *
 * PRODUCT BEHAVIOR (Jason's rules):
 *   1) Page gate (pagePassword) may be off — unlisted URL is enough friction;
 *      SCRIPT_PASSWORD remains for API auth.
 *   2) Submitter ACK early: HTTP success as soon as presentation (+ optional
 *      files) are safely in Drive. Message = upload complete / you're done.
 *   3) Team notify LATE: NOTIFY_EMAILS only after slide text extraction + text
 *      doc written, AND Gemini scripture step finished + scriptures doc written.
 *      If Gemini fails after text extraction: retry once, then still notify with
 *      the text doc + a note that scripture assist failed (teams must not wait
 *      forever). Do NOT notify on raw upload alone.
 *   4) Early-ACK pattern in GAS: doPost saves files, enqueues a pending job,
 *      schedules processQueuedSubmissions (and optionally self-calls
 *      processSubmission with a 1s UrlFetch timeout), then returns JSON success.
 *      Heavy work runs in a separate execution. See speaker/README.md.
 *
 * This is a reliability bridge. Longer-term intake: docs/SPEAKER_PORTAL_REBUILD.md
 */

var DEFAULT_NOTIFY_EMAILS = [
  'serviceexperience@anchorfalls.org',
  'media@anchorfalls.org',
  'video@anchorfalls.org',
  'communications@anchorfalls.org'
].join(',');

// Early reject before heavy Base64 decode / Drive work. Align with client cap.
var MAX_POST_CHARS = 28 * 1024 * 1024; // ~28M chars ≈ under GAS practical limits
var MAX_DECODED_BYTES = 20 * 1024 * 1024;

var PENDING_PREFIX = 'PENDING_';
var SUB_PREFIX = 'SUB_';
var PROCESS_TRIGGER_HANDLER = 'processQueuedSubmissions';

function getProp_(key, fallback) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return value;
}

function escapeHtml_(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseEmailList_(raw, fallback) {
  var source = raw || fallback || '';
  return source.split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s.indexOf('@') > 0; });
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function reportError_(message, contextDetails) {
  var details = contextDetails || {};
  var errorEmails = parseEmailList_(
    getProp_('ERROR_EMAILS', ''),
    getProp_('NOTIFY_EMAILS', DEFAULT_NOTIFY_EMAILS)
  );
  var subject = 'Speaker Portal error';
  var body =
    '<p><strong>Error:</strong> ' + escapeHtml_(message) + '</p>' +
    '<p><strong>Context:</strong></p><pre>' +
    escapeHtml_(JSON.stringify(details, null, 2)) +
    '</pre>';
  try {
    if (errorEmails.length) {
      MailApp.sendEmail({
        to: errorEmails.join(','),
        subject: subject,
        htmlBody: body
      });
    }
  } catch (mailErr) {
    console.error('reportError_ mail failed: ' + mailErr);
  }
  console.error(message, details);
}

/**
 * Idempotency / status cache in Script Properties (lightweight).
 * Keyed by submissionId → { folderUrl, folderId, mainFileId, status, ... }
 * status: uploaded | processing | notified
 */
function getCachedSubmission_(submissionId) {
  if (!submissionId) return null;
  var key = SUB_PREFIX + String(submissionId).slice(0, 80);
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function cacheSubmission_(submissionId, payload) {
  if (!submissionId) return;
  var key = SUB_PREFIX + String(submissionId).slice(0, 80);
  PropertiesService.getScriptProperties().setProperty(
    key,
    JSON.stringify(payload)
  );
}

function pendingKey_(submissionId) {
  return PENDING_PREFIX + String(submissionId).slice(0, 80);
}

function enqueuePending_(job) {
  if (!job || !job.submissionId) return;
  PropertiesService.getScriptProperties().setProperty(
    pendingKey_(job.submissionId),
    JSON.stringify(job)
  );
}

function readPending_(submissionId) {
  var raw = PropertiesService.getScriptProperties().getProperty(
    pendingKey_(submissionId)
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function clearPending_(submissionId) {
  PropertiesService.getScriptProperties().deleteProperty(
    pendingKey_(submissionId)
  );
}

function listPendingJobs_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var jobs = [];
  for (var key in props) {
    if (Object.prototype.hasOwnProperty.call(props, key) &&
        key.indexOf(PENDING_PREFIX) === 0) {
      try {
        jobs.push(JSON.parse(props[key]));
      } catch (e) {
        console.warn('Bad pending job ' + key + ': ' + e);
      }
    }
  }
  return jobs;
}

function createUniqueFolder_(parentFolder, baseName) {
  var name = baseName;
  var existing = parentFolder.getFoldersByName(name);
  var version = 2;
  while (existing.hasNext()) {
    name = baseName + ' v' + version;
    version++;
    existing = parentFolder.getFoldersByName(name);
  }
  return parentFolder.createFolder(name);
}

function estimateDecodedBytes_(b64) {
  if (!b64) return 0;
  var padding = 0;
  if (b64.slice(-2) === '==') padding = 2;
  else if (b64.slice(-1) === '=') padding = 1;
  return Math.floor(b64.length * 0.75) - padding;
}

function saveBase64File_(folder, fileName, mimeType, fileData) {
  var blob = Utilities.newBlob(
    Utilities.base64Decode(fileData),
    mimeType || 'application/octet-stream',
    fileName || 'upload.bin'
  );
  return folder.createFile(blob);
}

function extractTextFromPresentation_(file, serviceDate) {
  var contextDetails = {
    step: 'extractTextFromPresentation',
    fileName: file && file.getName ? file.getName() : '',
    serviceDate: serviceDate || ''
  };
  var copyId = null;
  try {
    var resource = {
      name: file.getName(),
      mimeType: 'application/vnd.google-apps.presentation'
    };
    var copy = Drive.Files.copy(resource, file.getId(), {
      supportsAllDrives: true
    });
    copyId = copy.id;
    var presentation = SlidesApp.openById(copyId);
    var slides = presentation.getSlides();
    var parts = [];
    for (var i = 0; i < slides.length; i++) {
      var slide = slides[i];
      var texts = [];
      var elements = slide.getPageElements();
      for (var j = 0; j < elements.length; j++) {
        var el = elements[j];
        if (el.getPageElementType() === SlidesApp.PageElementType.SHAPE) {
          var shapeText = el.asShape().getText().asString();
          if (shapeText && shapeText.trim()) texts.push(shapeText.trim());
        } else if (el.getPageElementType() === SlidesApp.PageElementType.TABLE) {
          var table = el.asTable();
          for (var r = 0; r < table.getNumRows(); r++) {
            for (var c = 0; c < table.getNumColumns(); c++) {
              var cellText = table.getCell(r, c).getText().asString();
              if (cellText && cellText.trim()) texts.push(cellText.trim());
            }
          }
        }
      }
      var notes = '';
      try {
        notes = slide.getNotesPage().getSpeakerNotesShape().getText().asString();
      } catch (notesErr) {
        notes = '';
      }
      parts.push(
        '--- Slide ' + (i + 1) + ' ---\n' +
        texts.join('\n') +
        (notes && notes.trim() ? '\n[Speaker notes]\n' + notes.trim() : '')
      );
    }
    return parts.join('\n\n');
  } catch (err) {
    reportError_('extractTextFromPresentation failed: ' + err, contextDetails);
    return '';
  } finally {
    if (copyId) {
      try {
        Drive.Files.remove(copyId);
      } catch (rm1) {
        try { DriveApp.getFileById(copyId).setTrashed(true); } catch (rm2) {}
      }
    }
  }
}

/**
 * Single Gemini attempt. Returns { text, error }.
 */
function callGeminiOnce_(presentationText, serviceDate) {
  var contextDetails = {
    step: 'getCorrectedScripturesFromGemini',
    serviceDate: serviceDate || '',
    textLength: presentationText ? presentationText.length : 0
  };
  var apiKey = getProp_('GEMINI_API_KEY', '');
  if (!apiKey) {
    return { text: '', error: 'GEMINI_API_KEY not configured' };
  }
  if (!presentationText) {
    return { text: '', error: 'No presentation text for scripture assist' };
  }
  try {
    var prompt =
      'From the sermon slide text below, extract scripture references and quote ' +
      'the passages clearly (ESV if unsure). Fix obvious reference typos. ' +
      'If none, reply with exactly: No scriptures found.\n\n' +
      presentationText.slice(0, 120000);

    var url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      'gemini-2.0-flash:generateContent?key=' + encodeURIComponent(apiKey);

    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      })
    });

    var code = response.getResponseCode();
    var body = response.getContentText();
    if (code < 200 || code >= 300) {
      reportError_('Gemini HTTP ' + code, Object.assign({}, contextDetails, {
        body: body.slice(0, 1000)
      }));
      return { text: '', error: 'Gemini HTTP ' + code };
    }
    var parsed = JSON.parse(body);
    var text =
      parsed &&
      parsed.candidates &&
      parsed.candidates[0] &&
      parsed.candidates[0].content &&
      parsed.candidates[0].content.parts &&
      parsed.candidates[0].content.parts[0] &&
      parsed.candidates[0].content.parts[0].text;
    return { text: text ? String(text) : '', error: text ? '' : 'Empty Gemini response' };
  } catch (err) {
    reportError_('Gemini step failed: ' + err, contextDetails);
    return { text: '', error: String(err) };
  }
}

/**
 * Gemini with one retry. On persistent failure, caller notifies teams with a note.
 */
function getCorrectedScripturesFromGemini_(presentationText, serviceDate) {
  var first = callGeminiOnce_(presentationText, serviceDate);
  if (first.text) {
    return { text: first.text, failed: false, error: '' };
  }
  // No key / no text: skip without retry noise (not a hard failure).
  if (first.error === 'GEMINI_API_KEY not configured' ||
      first.error === 'No presentation text for scripture assist') {
    return { text: '', failed: false, error: first.error };
  }
  // Retry once for reliability (transient HTTP / empty / throw).
  Utilities.sleep(1500);
  var second = callGeminiOnce_(presentationText, serviceDate);
  if (second.text) {
    return { text: second.text, failed: false, error: '' };
  }
  return {
    text: '',
    failed: true,
    error: second.error || first.error || 'Gemini scripture assist failed'
  };
}

function maybeGrantReader_(folderId, email) {
  if (!email || email.indexOf('@') < 0) return;
  try {
    Drive.Permissions.create(
      { type: 'user', role: 'reader', emailAddress: email },
      folderId,
      { sendNotificationEmail: false, supportsAllDrives: true }
    );
  } catch (err) {
    console.warn('Permission grant skipped: ' + err);
  }
}

function buildNotifyEmailHtml_(data) {
  return (
    '<p>A new speaker submission is ready for Media / livestream / video.</p>' +
    '<p><em>Files were saved earlier; this email is sent only after slide text ' +
    'processing (and scripture assist) finished.</em></p>' +
    '<ul>' +
    '<li><strong>Speaker:</strong> ' + escapeHtml_(data.speakerName) + '</li>' +
    '<li><strong>Sermon title:</strong> ' + escapeHtml_(data.sermonTitle) + '</li>' +
    '<li><strong>Service date:</strong> ' + escapeHtml_(data.serviceDate) + '</li>' +
    '<li><strong>Submitter email:</strong> ' + escapeHtml_(data.senderEmail || '(none)') + '</li>' +
    '<li><strong>Notes:</strong> ' + escapeHtml_(data.notes || '(none)') + '</li>' +
    '<li><strong>Drive folder:</strong> <a href="' + escapeHtml_(data.folderUrl) + '">' +
      escapeHtml_(data.folderUrl) + '</a></li>' +
    '<li><strong>Text doc:</strong> ' + escapeHtml_(data.textDocStatus || '') + '</li>' +
    '<li><strong>Scriptures doc:</strong> ' + escapeHtml_(data.scripturesDocStatus || '') + '</li>' +
    '<li><strong>Submission ID:</strong> ' + escapeHtml_(data.submissionId || '') + '</li>' +
    '</ul>' +
    '<p>Resources: PowerPoint template and Mulish / Montserrat fonts are linked from ' +
    '<a href="https://ergunkodesh.org/speaker/">the Speaker Portal</a>.</p>' +
    (data.scriptureNote
      ? '<p><em>' + escapeHtml_(data.scriptureNote) + '</em></p>'
      : '')
  );
}

/**
 * Ensure a one-shot time trigger exists for the processing queue.
 * GAS cannot finish HTTP after return; a separate execution does late work.
 * .after() is typically ~1 minute minimum in practice.
 */
function scheduleProcessQueue_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === PROCESS_TRIGGER_HANDLER) {
      return;
    }
  }
  ScriptApp.newTrigger(PROCESS_TRIGGER_HANDLER)
    .timeBased()
    .after(30 * 1000)
    .create();
}

function cleanupProcessTriggers_() {
  var remaining = listPendingJobs_();
  if (remaining.length) return;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === PROCESS_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

/**
 * Optional faster kickoff: POST action=processSubmission to WEB_APP_URL with
 * a 1-second UrlFetch timeout so this execution can return while the worker
 * continues. Falls back silently to the time trigger if unset/unsupported.
 */
function kickProcessAsync_(submissionId) {
  scheduleProcessQueue_();

  var webAppUrl = getProp_('WEB_APP_URL', '');
  if (!webAppUrl || !submissionId) return;

  try {
    UrlFetchApp.fetch(webAppUrl, {
      method: 'post',
      contentType: 'text/plain;charset=utf-8',
      muteHttpExceptions: true,
      timeoutSeconds: 1,
      payload: JSON.stringify({
        password: getProp_('SCRIPT_PASSWORD', ''),
        action: 'processSubmission',
        submissionId: submissionId
      })
    });
  } catch (err) {
    // Expected when timeoutSeconds aborts the wait; worker keeps running.
    // Also covers environments that reject timeoutSeconds — trigger remains.
    console.log('kickProcessAsync_ note: ' + err);
  }
}

/**
 * Late path: text extract → text doc → Gemini (retry once) → scriptures doc →
 * NOTIFY_EMAILS. Never called for speaker ACK.
 */
function processOneSubmission_(job) {
  var contextDetails = {
    step: 'processOneSubmission',
    submissionId: job.submissionId,
    serviceDate: job.serviceDate
  };

  var cached = getCachedSubmission_(job.submissionId) || {};
  if (cached.status === 'notified') {
    clearPending_(job.submissionId);
    return { ok: true, skipped: true };
  }

  cacheSubmission_(job.submissionId, Object.assign({}, cached, {
    folderUrl: job.folderUrl || cached.folderUrl,
    folderId: job.folderId || cached.folderId,
    mainFileId: job.mainFileId || cached.mainFileId,
    status: 'processing',
    at: new Date().toISOString()
  }));

  var folder = DriveApp.getFolderById(job.folderId);
  var mainFile = DriveApp.getFileById(job.mainFileId);

  var presentationText = '';
  var textDocWritten = false;
  var scriptureNote = '';
  var textDocStatus = 'not written';
  var scripturesDocStatus = 'not written';

  try {
    presentationText = extractTextFromPresentation_(mainFile, job.serviceDate) || '';
    if (presentationText) {
      var textName = (job.serviceDate || 'presentation') + ' presentation text.txt';
      folder.createFile(
        Utilities.newBlob(presentationText, 'text/plain', textName)
      );
      textDocWritten = true;
      textDocStatus = textName;
    } else {
      textDocStatus = 'extraction returned empty';
      scriptureNote =
        'Slide text extraction produced no text. Raw presentation files are in the folder.';
    }
  } catch (textErr) {
    reportError_('Text extract wrapper: ' + textErr, contextDetails);
    textDocStatus = 'extraction failed';
    scriptureNote =
      'Slide text extraction failed. Raw presentation files are in the folder.';
  }

  // Scripture assist only when we have text. Retry once inside helper.
  if (presentationText) {
    var gem = getCorrectedScripturesFromGemini_(presentationText, job.serviceDate);
    if (gem.text) {
      var sName = (job.serviceDate || 'presentation') + ' presentation scriptures.txt';
      folder.createFile(Utilities.newBlob(gem.text, 'text/plain', sName));
      scripturesDocStatus = sName;
    } else if (gem.failed) {
      scripturesDocStatus = 'scripture assist failed after retry';
      scriptureNote =
        (scriptureNote ? scriptureNote + ' ' : '') +
        'Scripture assist failed after one retry (' +
        (gem.error || 'unknown') +
        '). Text doc is available; please review slides manually.';
      var failNoteName =
        (job.serviceDate || 'presentation') + ' scripture assist FAILED.txt';
      try {
        folder.createFile(
          Utilities.newBlob(
            'Scripture assist failed after one retry.\n' +
              (gem.error || '') + '\n' +
              'Teams were still notified so Media is not blocked.\n',
            'text/plain',
            failNoteName
          )
        );
        scripturesDocStatus = failNoteName + ' (failure note)';
      } catch (noteErr) {
        console.warn('Could not write scripture failure note: ' + noteErr);
      }
    } else {
      scripturesDocStatus = 'skipped (no API key or empty text path)';
      scriptureNote =
        (scriptureNote ? scriptureNote + ' ' : '') +
        'Scripture assist skipped (no API key or no usable text).';
    }
  } else {
    scripturesDocStatus = 'skipped (no slide text)';
  }

  // Team notify LATE — after text + scripture steps attempted/written.
  // Still notify if text failed so Sunday teams are not blocked forever.
  var recipients = parseEmailList_(
    getProp_('NOTIFY_EMAILS', ''),
    DEFAULT_NOTIFY_EMAILS
  );
  if (recipients.length) {
    MailApp.sendEmail({
      to: recipients.join(','),
      subject:
        'Speaker submission ready: ' + (job.serviceDate || '') + ' — ' +
        (job.sermonTitle || job.speakerName || 'Untitled'),
      htmlBody: buildNotifyEmailHtml_({
        speakerName: job.speakerName,
        sermonTitle: job.sermonTitle,
        serviceDate: job.serviceDate,
        senderEmail: job.senderEmail,
        notes: job.notes,
        folderUrl: job.folderUrl,
        submissionId: job.submissionId,
        scriptureNote: scriptureNote,
        textDocStatus: textDocStatus,
        scripturesDocStatus: scripturesDocStatus
      })
    });
  }

  cacheSubmission_(job.submissionId, Object.assign({}, cached, {
    folderUrl: job.folderUrl,
    folderId: job.folderId,
    mainFileId: job.mainFileId,
    status: 'notified',
    textDocWritten: textDocWritten,
    at: new Date().toISOString()
  }));
  clearPending_(job.submissionId);
  return { ok: true, textDocWritten: textDocWritten };
}

/**
 * Time-driven / queue drain entry point (separate execution from speaker doPost).
 */
function processQueuedSubmissions() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.warn('processQueuedSubmissions: could not obtain lock');
    return;
  }
  try {
    var jobs = listPendingJobs_();
    for (var i = 0; i < jobs.length; i++) {
      try {
        processOneSubmission_(jobs[i]);
      } catch (err) {
        reportError_('processOneSubmission failed: ' + err, {
          submissionId: jobs[i] && jobs[i].submissionId
        });
        // Leave pending for a later trigger retry; re-schedule.
      }
    }
    if (listPendingJobs_().length) {
      scheduleProcessQueue_();
    } else {
      cleanupProcessTriggers_();
    }
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  var contextDetails = { step: 'doPost' };
  try {
    if (!e || e.postData == null || e.postData.contents == null) {
      return jsonResponse_({ status: 'error', message: 'Empty request body.' });
    }

    var raw = e.postData.contents;
    contextDetails.payloadChars = raw.length;
    if (raw.length > MAX_POST_CHARS) {
      return jsonResponse_({
        status: 'error',
        message: 'Upload too large for this portal. Email media@anchorfalls.org instead.'
      });
    }

    var data = JSON.parse(raw);
    contextDetails.speakerName = data.speakerName;
    contextDetails.serviceDate = data.serviceDate;
    contextDetails.submissionId = data.submissionId;
    contextDetails.action = data.action || 'submit';

    var expectedPassword = getProp_('SCRIPT_PASSWORD', '');
    if (!expectedPassword || data.password !== expectedPassword) {
      return jsonResponse_({ status: 'error', message: 'Unauthorized.' });
    }

    // Worker path: process one queued submission (self-call or manual).
    if (data.action === 'processSubmission') {
      var job = readPending_(data.submissionId);
      if (!job) {
        var cachedOnly = getCachedSubmission_(data.submissionId);
        return jsonResponse_({
          status: 'success',
          message: cachedOnly && cachedOnly.status === 'notified'
            ? 'Already processed.'
            : 'No pending job for that submissionId.'
        });
      }
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) {
        return jsonResponse_({
          status: 'error',
          message: 'Processor busy; time trigger will retry.'
        });
      }
      try {
        processOneSubmission_(job);
        cleanupProcessTriggers_();
      } finally {
        lock.releaseLock();
      }
      return jsonResponse_({ status: 'success', message: 'Processed.' });
    }

    if (!data.fileData || !data.fileName) {
      return jsonResponse_({
        status: 'error',
        message: 'Presentation file is required.'
      });
    }

    var cached = getCachedSubmission_(data.submissionId);
    if (cached && cached.folderUrl) {
      // Upload already ACK'd earlier — never re-save; ensure processing is queued.
      if (cached.status !== 'notified' && cached.folderId && cached.mainFileId) {
        enqueuePending_({
          submissionId: data.submissionId,
          folderId: cached.folderId,
          folderUrl: cached.folderUrl,
          mainFileId: cached.mainFileId,
          speakerName: data.speakerName || '',
          sermonTitle: data.sermonTitle || '',
          serviceDate: data.serviceDate || '',
          senderEmail: data.senderEmail || '',
          notes: data.notes || ''
        });
        kickProcessAsync_(data.submissionId);
      }
      return jsonResponse_({
        status: 'success',
        duplicate: true,
        message:
          'Upload already complete — you\'re done. Media is notified after ' +
          'slide text processing (not on the raw upload alone).',
        folderUrl: cached.folderUrl
      });
    }

    var decodedBytes = estimateDecodedBytes_(data.fileData);
    var additional = data.additionalFiles || [];
    for (var i = 0; i < additional.length; i++) {
      decodedBytes += estimateDecodedBytes_(additional[i].fileData);
    }
    if (decodedBytes > MAX_DECODED_BYTES) {
      return jsonResponse_({
        status: 'error',
        message: 'Files exceed the ' + Math.floor(MAX_DECODED_BYTES / (1024 * 1024)) +
          ' MB limit. Email media@anchorfalls.org instead.'
      });
    }

    var parentId = getProp_('PARENT_FOLDER_ID', '');
    var sheetId = getProp_('SHEET_ID', '');
    if (!parentId || !sheetId) {
      reportError_('Missing PARENT_FOLDER_ID or SHEET_ID script property', contextDetails);
      return jsonResponse_({
        status: 'error',
        message: 'Server is not fully configured. Please email media@anchorfalls.org.'
      });
    }

    var parentFolder = DriveApp.getFolderById(parentId);
    var baseName = (data.serviceDate || 'undated') + ' - ' + (data.speakerName || 'speaker');
    var folder = createUniqueFolder_(parentFolder, baseName);
    var folderUrl = folder.getUrl();
    contextDetails.folderUrl = folderUrl;

    maybeGrantReader_(folder.getId(), data.senderEmail);

    var mainFile = saveBase64File_(
      folder,
      data.fileName,
      data.mimeType,
      data.fileData
    );

    for (var a = 0; a < additional.length; a++) {
      var f = additional[a];
      if (!f || !f.fileData || !f.fileName) continue;
      saveBase64File_(folder, f.fileName, f.mimeType, f.fileData);
    }

    // Sheet row is part of "safely saved" bookkeeping (not team notify).
    try {
      var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
      sheet.appendRow([
        new Date(),
        data.speakerName || '',
        data.sermonTitle || '',
        data.serviceDate || '',
        folderUrl,
        data.submissionId || '',
        data.senderEmail || '',
        'uploaded'
      ]);
    } catch (sheetErr) {
      reportError_('Sheet append failed: ' + sheetErr, contextDetails);
      // Continue — files are already in Drive
    }

    var job = {
      submissionId: data.submissionId,
      folderId: folder.getId(),
      folderUrl: folderUrl,
      mainFileId: mainFile.getId(),
      speakerName: data.speakerName || '',
      sermonTitle: data.sermonTitle || '',
      serviceDate: data.serviceDate || '',
      senderEmail: data.senderEmail || '',
      notes: data.notes || ''
    };

    cacheSubmission_(data.submissionId, {
      folderUrl: folderUrl,
      folderId: job.folderId,
      mainFileId: job.mainFileId,
      status: 'uploaded',
      at: new Date().toISOString()
    });
    enqueuePending_(job);

    // Kick separate execution for text + Gemini + LATE team email, then ACK.
    kickProcessAsync_(data.submissionId);

    // Early submitter ACK — do not wait for Gemini or NOTIFY_EMAILS.
    return jsonResponse_({
      status: 'success',
      message:
        'Upload complete — you\'re done. The media team is notified after ' +
        'slide text and scripture processing finish (usually within a minute).',
      folderUrl: folderUrl
    });
  } catch (err) {
    reportError_('doPost failed: ' + err, contextDetails);
    return jsonResponse_({
      status: 'error',
      message: 'Server error while saving. Please email media@anchorfalls.org with your files.'
    });
  }
}
