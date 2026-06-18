import { Router } from 'express';

const router = Router();

router.get('/:id', (req, res) => {
  res.redirect(301, `https://quickres.pro/r/${req.params.id}`);
});

export default router;
