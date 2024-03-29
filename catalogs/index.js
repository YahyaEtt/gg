import express from 'express';
import serverless from './serverless.js';

const app = express();

app.use((req, res, next) => serverless(req, res, next));
app.listen(process.env.PORT || 7000, () => {
  console.log(`Started addon at: http://localhost:${process.env.PORT || 7000}`);
});
