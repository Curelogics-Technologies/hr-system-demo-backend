import { Router } from 'express';
import { webhookController } from './webhook.controller';

const router = Router();

// Note: /stripe requires raw body Buffer (handled in src/index.ts)
router.post('/stripe', (req, res) => webhookController.handleStripe(req, res));

router.post('/paypal', (req, res) => webhookController.handlePayPal(req, res));

export default router;
