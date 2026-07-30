import { Router } from 'express';
import { authenticate, requireRole, requireModulePermission } from '../../middleware/auth';
import {
  listJobsHandler, getJobHandler, getJobComplianceHandler, createJobHandler, updateJobHandler,
  deleteJobHandler, publishJobHandler, syncJobHandler,
  listCandidatesHandler, getCandidateHandler, createCandidateHandler,
  updateCandidateHandler, updateCandidateTagsHandler, deleteCandidateHandler,
  listInterviewersHandler,
  listInterviewsHandler, listAllInterviewsHandler, createInterviewHandler, updateInterviewHandler,
  deleteInterviewHandler, getAlertsHandler, getRisksHandler,
  jobFeedHandler,
  listCandidateCommentsHandler, addCandidateCommentHandler, deleteCandidateCommentHandler,
  listInterviewFeedbackCommentsHandler, addInterviewFeedbackCommentHandler, deleteInterviewFeedbackCommentHandler,
  listAllInterviewFeedbackCommentsHandler,
  listInterviewNotificationsHandler, sendInterviewNotificationHandler,
  candidateProfilePdfHandler,
  getIndeedStatsHandler,
  testSsrHandler,
  listScreenerQuestionsHandler,
  createScreenerQuestionHandler,
  updateScreenerQuestionHandler,
  deleteScreenerQuestionHandler,
  getCandidateRetentionHandler,
  updateCandidateRetentionHandler,
  previewCandidateRetentionHandler,
} from './ats.controller';
import { optionalInternalResumeUpload } from './atsCvUpload';

const router = Router();

// ── Public feed (no auth) ──────────────────────────────────────────────────
// Indeed and other job boards crawl this XML feed. Register the URL in their
// Publisher / Job Feed portal — no API key needed.
// URL: GET /api/ats/feed/:slug/jobs.xml
router.get('/feed/:slug/jobs.xml', jobFeedHandler);
router.get('/candidates/:candidateId/profile.pdf', candidateProfilePdfHandler);

router.use(authenticate);
router.use(requireModulePermission('ats'));

// Job postings
router.get('/jobs',                         listJobsHandler);
router.post('/jobs',                        requireRole('admin', 'hr'), createJobHandler);
router.get('/jobs/:id',                     getJobHandler);
router.get('/jobs/:identifier/compliance',  requireRole('admin', 'hr'), getJobComplianceHandler);
router.patch('/jobs/:id',                   requireRole('admin', 'hr'), updateJobHandler);
router.delete('/jobs/:id',        requireRole('admin', 'hr'), deleteJobHandler);
router.post('/jobs/:id/publish',  requireRole('admin', 'hr'), publishJobHandler);
router.post('/jobs/:id/sync',     requireRole('admin', 'hr'), syncJobHandler);

// Job screener questions
router.get('/jobs/:jobId/screener-questions', listScreenerQuestionsHandler);
router.post('/jobs/:jobId/screener-questions', requireRole('admin', 'hr'), createScreenerQuestionHandler);
router.put('/jobs/:jobId/screener-questions/:qId', requireRole('admin', 'hr'), updateScreenerQuestionHandler);
router.delete('/jobs/:jobId/screener-questions/:qId', requireRole('admin', 'hr'), deleteScreenerQuestionHandler);

// GDPR candidate retention policy.
// Declared before '/candidates/:id' so "retention" is not swallowed as an id.
router.get('/candidates/retention',          requireRole('admin', 'hr'), getCandidateRetentionHandler);
router.put('/candidates/retention',          requireRole('admin'), updateCandidateRetentionHandler);
router.get('/candidates/retention/preview',  requireRole('admin', 'hr'), previewCandidateRetentionHandler);

// Candidates
router.get('/candidates',         listCandidatesHandler);
router.get('/interviewers',       requireRole('admin', 'hr', 'area_manager', 'store_manager'), listInterviewersHandler);
router.post('/candidates',        optionalInternalResumeUpload, createCandidateHandler);
router.get('/candidates/:id',     getCandidateHandler);
router.patch('/candidates/:id',   requireRole('admin', 'hr', 'area_manager', 'store_manager'), updateCandidateHandler);
router.patch('/candidates/:id/tags', requireRole('admin', 'hr', 'area_manager', 'store_manager'), updateCandidateTagsHandler);
router.delete('/candidates/:id',  requireRole('admin', 'hr'), deleteCandidateHandler);

// Candidate Comments
router.get('/candidates/:candidateId/comments',  requireRole('admin', 'hr', 'area_manager', 'store_manager'), listCandidateCommentsHandler);
router.post('/candidates/:candidateId/comments', requireRole('admin', 'hr', 'area_manager', 'store_manager'), addCandidateCommentHandler);
router.delete('/comments/:id',                   requireRole('admin', 'hr'), deleteCandidateCommentHandler);

// Interviews - Get all interviews (for calendar view)
router.get('/interviews', listAllInterviewsHandler);

// Interviews nested under candidates
router.get('/candidates/:candidateId/interviews',  listInterviewsHandler);
router.post('/candidates/:candidateId/interviews', requireRole('admin', 'hr', 'area_manager', 'store_manager'), createInterviewHandler);

// Interview feedback comments
router.get('/interviews/feedback/all',        requireRole('admin', 'hr', 'area_manager', 'store_manager'), listAllInterviewFeedbackCommentsHandler);
router.patch('/interviews/:id',               requireRole('admin', 'hr', 'area_manager', 'store_manager'), updateInterviewHandler);
router.delete('/interviews/:id',              requireRole('admin', 'hr'), deleteInterviewHandler);
// Interview feedback comments
router.get('/interviews/:interviewId/feedback',  requireRole('admin', 'hr', 'area_manager', 'store_manager'), listInterviewFeedbackCommentsHandler);
router.post('/interviews/:interviewId/feedback', requireRole('admin', 'hr', 'area_manager', 'store_manager'), addInterviewFeedbackCommentHandler);
router.delete('/interviews/feedback/:id',        requireRole('admin', 'hr', 'area_manager', 'store_manager'), deleteInterviewFeedbackCommentHandler);
router.get('/interviews/:id/notifications',   requireRole('admin', 'hr'), listInterviewNotificationsHandler);
router.post('/interviews/:id/notifications/send', requireRole('admin', 'hr'), sendInterviewNotificationHandler);

// Alerts + Risks
router.get('/alerts', requireRole('admin', 'hr', 'area_manager', 'store_manager'), getAlertsHandler);
router.get('/risks',  requireRole('admin', 'hr'), getRisksHandler);
router.get('/indeed-stats', requireRole('admin', 'hr'), getIndeedStatsHandler);
router.get('/test-ssr', requireRole('admin', 'hr'), testSsrHandler);

export default router;
