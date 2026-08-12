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
 *   GEMINI_API_KEY    = optional; scripture assist only — never blocks save/notify
 *
 * Also enable Advanced Google services if not already:
 *   - Drive API
 *   - Google Slides API
 *
 * After deploy: put the /exec URL into speaker/config.js as googleScriptUrl,
 * rotate SCRIPT_PASSWORD (old HTML passwords are public), and test once.
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
 * Idempotency cache in Script Properties (lightweight).
 * Keyed by submissionId → folder URL.
 */
function getCachedSubmission_(submissionId) {
  if (!submissionId) return null;
  var key = 'SUB_' + String(submissionId).slice(0, 80);
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
  var key = 'SUB_' + String(submissionId).slice(0, 80);
  PropertiesService.getScriptProperties().setProperty(
    key,
    JSON.stringify(payload)
  );
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
    // Drive advanced service v3: copy with Google Slides MIME to convert Office decks.
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

function getCorrectedScripturesFromGemini_(presentationText, serviceDate) {
  var contextDetails = {
    step: 'getCorrectedScripturesFromGemini',
    serviceDate: serviceDate || '',
    textLength: presentationText ? presentationText.length : 0
  };
  var apiKey = getProp_('GEMINI_API_KEY', '');
  if (!apiKey || !presentationText) {
    return '';
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
      return '';
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
    return text ? String(text) : '';
  } catch (err) {
    reportError_('Gemini step failed: ' + err, contextDetails);
    return '';
  }
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
    '<p>A new speaker submission was received.</p>' +
    '<ul>' +
    '<li><strong>Speaker:</strong> ' + escapeHtml_(data.speakerName) + '</li>' +
    '<li><strong>Sermon title:</strong> ' + escapeHtml_(data.sermonTitle) + '</li>' +
    '<li><strong>Service date:</strong> ' + escapeHtml_(data.serviceDate) + '</li>' +
    '<li><strong>Submitter email:</strong> ' + escapeHtml_(data.senderEmail || '(none)') + '</li>' +
    '<li><strong>Notes:</strong> ' + escapeHtml_(data.notes || '(none)') + '</li>' +
    '<li><strong>Drive folder:</strong> <a href="' + escapeHtml_(data.folderUrl) + '">' +
      escapeHtml_(data.folderUrl) + '</a></li>' +
    '<li><strong>Submission ID:</strong> ' + escapeHtml_(data.submissionId || '') + '</li>' +
    '</ul>' +
    '<p>Resources: PowerPoint template and Mulish / Montserrat fonts are linked from ' +
    '<a href="https://ergunkodesh.org/speaker/">the Speaker Portal</a>.</p>' +
    (data.scriptureNote
      ? '<p><em>' + escapeHtml_(data.scriptureNote) + '</em></p>'
      : '')
  );
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

    var expectedPassword = getProp_('SCRIPT_PASSWORD', '');
    if (!expectedPassword || data.password !== expectedPassword) {
      return jsonResponse_({ status: 'error', message: 'Unauthorized.' });
    }

    if (!data.fileData || !data.fileName) {
      return jsonResponse_({ status: 'error', message: 'Presentation file is required.' });
    }

    var cached = getCachedSubmission_(data.submissionId);
    if (cached && cached.folderUrl) {
      return jsonResponse_({
        status: 'success',
        duplicate: true,
        message: 'Already received. Media has your previous submission.',
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

    // Text extraction + Gemini are best-effort and must never block notify.
    var presentationText = '';
    var scriptures = '';
    var scriptureNote = '';
    try {
      presentationText = extractTextFromPresentation_(mainFile, data.serviceDate) || '';
      if (presentationText) {
        var textName = (data.serviceDate || 'presentation') + ' presentation text.txt';
        folder.createFile(
          Utilities.newBlob(presentationText, 'text/plain', textName)
        );
      }
    } catch (textErr) {
      reportError_('Text extract wrapper: ' + textErr, contextDetails);
      scriptureNote = 'Slide text extraction had a problem; files were still saved.';
    }

    try {
      scriptures = getCorrectedScripturesFromGemini_(presentationText, data.serviceDate) || '';
      if (scriptures) {
        var sName = (data.serviceDate || 'presentation') + ' presentation scriptures.txt';
        folder.createFile(Utilities.newBlob(scriptures, 'text/plain', sName));
      }
    } catch (gemErr) {
      reportError_('Gemini wrapper: ' + gemErr, contextDetails);
      scriptureNote = scriptureNote ||
        'Scripture assist skipped; files and notification still succeeded.';
    }

    try {
      var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
      sheet.appendRow([
        new Date(),
        data.speakerName || '',
        data.sermonTitle || '',
        data.serviceDate || '',
        folderUrl,
        data.submissionId || '',
        data.senderEmail || ''
      ]);
    } catch (sheetErr) {
      reportError_('Sheet append failed: ' + sheetErr, contextDetails);
      // Continue — files are already in Drive
    }

    var recipients = parseEmailList_(
      getProp_('NOTIFY_EMAILS', ''),
      DEFAULT_NOTIFY_EMAILS
    );
    // Never silently add personal Gmail defaults; properties/list only.
    if (recipients.length) {
      MailApp.sendEmail({
        to: recipients.join(','),
        subject:
          'Speaker submission: ' + (data.serviceDate || '') + ' — ' +
          (data.sermonTitle || data.speakerName || 'Untitled'),
        htmlBody: buildNotifyEmailHtml_({
          speakerName: data.speakerName,
          sermonTitle: data.sermonTitle,
          serviceDate: data.serviceDate,
          senderEmail: data.senderEmail,
          notes: data.notes,
          folderUrl: folderUrl,
          submissionId: data.submissionId,
          scriptureNote: scriptureNote
        })
      });
    }

    cacheSubmission_(data.submissionId, {
      folderUrl: folderUrl,
      at: new Date().toISOString()
    });

    return jsonResponse_({
      status: 'success',
      message: 'Thank you — your presentation was received and the media team has been notified.',
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
