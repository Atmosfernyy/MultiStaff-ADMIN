const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();
const PORT = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],objectSrc:["'none'"],frameAncestors:["'none'"]}}}));
app.use(express.json({limit:'32kb'}));
app.use('/api', rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-7',legacyHeaders:false}));
app.get('/api/health',(_req,res)=>{res.set('Cache-Control','no-store');res.json({ok:true,service:'multistaff-admin',mode:process.env.FIREBASE_SERVICE_ACCOUNT_JSON?'firebase-configured':'setup-required'});});
// Management endpoints must be added together with server-side Developer authorization.
// Never trust a role, Telegram ID, or selected cinema supplied only by the browser.
app.use(express.static(path.join(__dirname,'public'),{extensions:['html'],maxAge:process.env.NODE_ENV==='production'?'1h':0,etag:true}));
app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log(`MultiStaff ADMIN listening on port ${PORT}`));
