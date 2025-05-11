import express from 'express';
import { startHumanLoop } from '../engine/behaviorWIthApi'; // Automatically starts behavior

const app = express();
app.use(express.json());

// Start server
app.listen(3000, () => {
  console.log('⚡ Express server running on http://localhost:3000');
  startHumanLoop(); // ← Start bot behavior on server boot
});
