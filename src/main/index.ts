// Source maps and debugging tools
import 'source-map-support/register';

// Libraries
import * as passport from 'passport';
import * as OAuth2Strategy from 'passport-oauth2';
import * as express from 'express';
import * as opn from 'opn';
import * as nodemailer from 'nodemailer';
// import * as multer from 'multer';
import * as bodyParser from 'body-parser';
import * as mustache from 'mustache';
import * as readFile from 'fs-readfile-promise';
import * as fs from 'fs';

// Homebrew
import TokenWrapper from '../utils/TokenWrapper';
import AuthBootstrap from '../utils/auth-bootstrap';
import Exact from './Exact';
import MailSettings from './MailSettings';

// Constants
const app = express();
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Globals
let e: Exact;
let mailSettings: MailSettings;
let accounts: any; // list of accounts (cached)

const injector = new AuthBootstrap();
const tokenWrapper = injector.getTokenWrapper();
injector.hookServer(app, '/auth', async (req: express.Request , res: express.Response) => {
  try {
    e = new Exact(tokenWrapper);
    await e.testInternet();
    await e.initAPI();
    res.redirect('/');
  } catch (e) {
    res.json(e);
  }
});

app.get('/', async (req: express.Request , res: express.Response) => {
  try {
    if (!e) {
      res.redirect('/auth');
    }

    res.type('html');
    res.write('Logged in as ' + await e.getMyName() + '.<br>\n');
    res.write('<br>\n')
    res.write('<a href="/mail-form.html">Enter mail settings</a><br>\n');
    res.write('<a href="/send-mail">Send test email</a><br>\n');
    res.write('<br>\n');
    res.write('<a href="/accounts">List accounts</a><br>\n');
    res.write('<a href="/accbal">List account balances</a><br>\n');
    res.write('<br>\n');

    res.end();
  } catch (e) {
    res.json(e);
  }
});

app.post('/save-settings', (req: express.Request, res: express.Response) => {
  const { server, email, password} = req.body;
  mailSettings = new MailSettings( server, email, password); // TODO(@jlicht): filthy global
  res.redirect('/');
});

function readTemplate(filename: string): string {
  return fs.readFileSync( __dirname + '/../../templates/' + filename, 'utf8');
}

app.get('/send-mail', async (req: express.Request, res: express.Response) => {
  try {
    if (!mailSettings) {
      throw new Error('Invalid State Error: mailsettings have not been setup.');
    }
    const html = mustache.to_html(readTemplate('standard_email'), {name: 'Piet Paulusma'});
    const mailOptions = {
      from: '"Treasurer-auto AEGEE-Delft" <invoice@aegee-delft.nl>',
      to: '"Jelle Test" <jlicht@posteo.net>',
      subject: 'Test mailsysteem',
      text: 'message - test',
      html,
    };

    const info = await mailSettings.getTransporter().sendMail(mailOptions);
    console.log('Message %s sent: %s', info.messageId, info.response);

    res.json({});
  } catch (e) {
    res.json(e);
    console.dir(e);
  }
});

const roundMoney = (b) => {
  return Math.round(b * 100) / 100;
};

const formatBalance = (b): string => {
  b = roundMoney(b);
  if (b < 0) {
    return '<span style="color: red">' + b.toFixed(2) + '</span>';
  } else {
    return '<span style="color: green">' + b.toFixed(2) + '</span>';
  }
};

app.get('/verify', async (req: express.Request , res: express.Response) => {
  try {
    res.json(await tokenWrapper.getTokenPromise());
  } catch (e) {
    res.json(e);
  }
});

app.get('/accounts', async (req: express.Request , res: express.Response) => {
  res.type('html');
  try {
    res.write('Listing all debitor/creditor accounts...<br><br>\n');

    if(accounts == undefined) {
      accounts = await e.getDebtors();
    }
    const template = `<table>{{#.}}<tr>
      <td>{{Code}}</td>
      <td><a href="/account/{{ID}}">{{Name}}</a></td>
      <td>{{Email}}</td>
      <td><a href="/trans/{{ID}}">Transactions</a></td>
      </tr>{{/.}}</table>`;
    const html = mustache.render(template, accounts);
    res.write(html);
  } catch (e) {
    res.write('ERROR: ' + JSON.stringify(e));
  }
  res.end();
});

app.get('/account/:accId', async (req: express.Request, res: express.Response) => {
  try {
    const contact = await e.getAccount(req.params.accId);
    contact.BankAccounts = await e.getAccountBankAccounts(req.params.accId);
    contact.trans = await e.getTransactionsObj(req.params.accId);
    res.json(contact);
  } catch (e) {
    res.json(e);
  }
});

app.get('/accbal', async (req: express.Request, res: express.Response) => {
  res.type('html');
  res.charset = 'utf-8';
  try {
    res.write('Retreiving account list...<br>\n');
    if (accounts == null) {
      accounts = await e.getDebtors();
    }
    res.write('OK, got ' + accounts.length + ' accounts. Fetching transactions and computing balances... <br><br>\n');

    accounts = accounts.reverse();
    for (let i = 0; i < accounts.length; i++) {

      if (accounts[i].trans == null) {
        accounts[i].trans = await e.getTransactionsObj(accounts[i].ID);
        accounts[i].balance = accounts[i].trans.balance;
        accounts[i].balanceHTML = formatBalance(accounts[i].trans.balance);

        if (accounts[i].trans.balance !== 0) {
          accounts[i].MainBankAccount = await e.getAccountMainBankAccount(accounts[i].ID);
        }
      }

      // Display progress indicator
      if (i % 10 === 0) {
        res.write('.');
      }
    }

    res.write('<br><br>Done.<br><br>');

    const template = `<table>{{#.}}<tr>
      <td style="text-align: right;">{{Code}}</td>
      <td><a href="/account/{{ID}}">{{Name}}</a></td>
      <td>{{Email}}</td>
      <td>{{MainBankAccount.IBAN}}</td>
      <td style="text-align: right;">{{{balanceHTML}}}</td>
      <td><a href="/trans/{{ID}}">Transactions</a></td>
      <td><a href="/preview-mail/{{ID}}">Preview mail</a></td>
      </tr>{{/.}}</table>`;

    let debcred = accounts.filter((x) => x.balance !== undefined && x.balance !== 0);
    res.write('Got ' + debcred.length + ' people with non-zero balance.');
    res.write('<br><br>');

    // Sort by name (ascending)
    debcred = debcred.sort( (a, b) => {
      if (a.Name < b.Name) {
        return -1;
      } else if (a.Name > b.Name) {
        return 1;
      }
      return 0;
    });

    const creditors = debcred.filter((x) => x.balance > 0);
    res.write('Got ' + creditors.length + ' creditors: <br><br>');
    res.write(mustache.render(template, creditors));
    res.write('<br><br>');

    const debitors = debcred.filter((x) => x.balance < 0);
    res.write('Got ' + debitors.length + ' debitors: <br><br>');
    res.write(mustache.render(template, debitors));
    res.write('<br><br>');

  } catch (e) {
    res.write('ERROR: ' + JSON.stringify(e));
  }
  res.end();
});

app.get('/verify', async (req: express.Request , res: express.Response) => {
  try {
    res.json(await tokenWrapper.getTokenPromise());
  } catch (e) {
    res.json(e);
  }
});

const formatTransactionList = (trans): string => {
  const formatMoney = (n) => {
    const s = n < 0 ? '-' : '+';
    const str = Math.abs(n).toFixed(2);
    return '€ ' + s + '&nbsp;&nbsp;&nbsp;&nbsp;'.substring(0, 6 * (6 - str.length)) + str;
  };

  // Convert a Microsoft AJAX date string (from the Exact API) to a human readable format
  // e.g. "/Date(012345687)/" to "2017-05-26"
  const fixDate = (d) => {
    const date = new Date(parseInt(d.substr(6)));
    return date.toISOString().substring(0, 10);
  };

  let tlist = trans.tList
    .map((x) => x.FinancialYear + '.' + x.FinancialPeriod + ' | ' + fixDate(x.Date)
         + ' | <kbd>' + formatMoney(-x.AmountDC) + '</kbd> | ' + x.Description);

  tlist = tlist.join('<br>\n');
  tlist = tlist + '<br><br>';

  const transSum = trans.map((x) => -x.AmountDC).reduce((a, b) => a + b, 0);

  tlist = tlist + 'Start balance: ' + formatMoney(trans.balance - transSum) + '<br>';
  tlist = tlist + 'Year balance: ' + formatMoney(transSum) + '<br>';
  tlist = tlist + 'End balance: ' + formatMoney(trans.balance);

  return tlist;
};

// Turn an array of transactions into an HTML formatted table
const formatTransactionTable = (trans): string => {
  // Convert a Microsoft AJAX date string (from the Exact API) to a human readable format
  // e.g. "/Date(012345687)/" to "2017-05-26"
  const fixDate = (d) => {
    const date = new Date(parseInt(d.substr(6)));
    return date.toISOString().substring(0, 10);
  };

  let tblStr = '<table style="border-spacing: 7pt 0pt">\n';

  tblStr = tblStr + '<tr>'
    + '<th style="text-align: left">' + 'Periode</th>'
    + '<th style="text-align: left">' + 'Datum</th>'
    + '<th style="text-align: left">' + 'Omschrijving</th>'
    + '<th style="text-align: right">' + 'Uit (€)</th>'
    + '<th style="text-align: right">' + 'In (€)</th>'
    + '</tr>\n';

  const rows = trans.tList.map((x) => '<tr>'
                       + '<td>' + x.FinancialYear + '.' + x.FinancialPeriod + '</td>'
                       + '<td>' + fixDate(x.Date) + '</td>'
                       + '<td>' + x.Description + '</td>'
                       + '<td style="color: red; text-align: right">' + ((-x.AmountDC < 0) ? (-x.AmountDC).toFixed(2) : '') + '</td>'
                       + '<td style="color: green; text-align: right">' + ((-x.AmountDC >= 0) ? (-x.AmountDC).toFixed(2) : '') + '</td>'
                       + '</tr>\n');

  tblStr = tblStr + rows.join('');

  const outSum = trans.tList.map((x) => (-x.AmountDC < 0) ? -x.AmountDC : 0).reduce((a, b) => a + b, 0);
  const inSum = trans.tList.map((x) => (-x.AmountDC > 0) ? -x.AmountDC : 0).reduce((a, b) => a + b, 0);
  const netSum = inSum + outSum;
  let startBalance = trans.balance - netSum;
  let balance = trans.balance;

  tblStr = tblStr + '<tr><td>&nbsp;</td></tr>\n';

  tblStr = tblStr + '<tr>'
    + '<td>' + '</td>'
    + '<td>' + '</td>'
    + '<th style="text-align: left">' + 'Totaal' + '</th>'
    + '<td style="color: red; text-align: right">' + outSum.toFixed(2) + '</td>'
    + '<td style="color: green; text-align: right">' + inSum.toFixed(2) + '</td>'
    + '</tr>\n';

  tblStr = tblStr + '<tr><td>&nbsp;</td></tr>\n';

  // Needed to avoid "-0.00"
  // !! Use only after calculations are done since precision is lost
  startBalance = Math.round(startBalance * 100) / 100;
  balance = Math.round(balance * 100) / 100;

  tblStr = tblStr + '<tr>'
    + '<td>' + '</td>'
    + '<td>' + '</td>'
    + '<th style="text-align: left">' + 'Beginsaldo:' + '</th>'
    + '<td style="color: red; text-align: right">' + ((startBalance < 0) ? startBalance.toFixed(2) : '') + '</td>'
    + '<td style="color: green; text-align: right">' + (startBalance >= 0 ? startBalance.toFixed(2) : '') + '</td>'
    + '</tr>\n';

  tblStr = tblStr + '<tr>'
    + '<td>' + '</td>'
    + '<td>' + '</td>'
    + '<th style="text-align: left">' + 'Saldo:' + '</th>'
    + '<td style="color: red; text-align: right">' + ((balance < 0) ? balance.toFixed(2) : '') + '</td>'
    + '<td style="color: green; text-align: right">' + (balance >= 0 ? balance.toFixed(2) : '') + '</td>'
    + '</tr>\n';

  tblStr = tblStr + '</table>\n';

  return tblStr;
};

app.get('/trans/:accId/:year*?', async (req: express.Request, res: express.Response) => {
  res.type('html');
  res.charset = 'utf-8';
  try {
    const account = await e.getAccount(req.params.accId);
    res.write('Listing transaction lines for ' + account.Name + ':<br><br>\n');

    const trans = await e.getTransactionsObj(req.params.accId);

    const years = [...new Set(trans.tList.map((x) => x.FinancialYear))];
    res.write(years.map((x) => '<a href="/trans/' + req.params.accId + '/' + x + '">' + x + '</a> ').join(' '));
    res.write('<br><br>');

    if ('year' in req.params && req.params.year) {
      trans.tList = trans.tList.filter((x) => x.FinancialYear === req.params.year);
    }

    res.write(formatTransactionTable(trans));

    res.write('<br><br><a href="/preview-mail/' + account.ID + '">Preview Email</a>');
  } catch (e) {
    res.write('ERROR: ' + JSON.stringify(e));
  }
  res.end();
});

const makeIncassoMail = async (account, trans) => {
  const variables = {
    name: account.Name,
    amount: Math.abs(trans.balance).toFixed(2),
    balance: trans.balance.toFixed(2),
    balanceColored: formatBalance(trans.balance),
    transactions: formatTransactionTable(trans),
  };

  let template = (await readFile('templates/standard_email')).toString();
  if (trans.balance <= -100) {
    template = (await readFile('templates/extreme_email')).toString();
  }
  const body = mustache.render(template, variables);

  const mailOptions = {
    from: '"Treasurer-auto AEGEE-Delft" <invoice@aegee-delft.nl>',
    to: '"' + account.Name + '" <' + account.Email + '>',
    subject: 'Incasso',
    text: 'Please view HTML body',
    html: body,
  };

  return mailOptions;
};

app.get('/preview-mail/:accId/', async (req: express.Request, res: express.Response) => {
  res.type('html');
  res.charset = 'utf-8';
  try {
    const account = await e.getAccount(req.params.accId);
    const trans = await e.getTransactionsObj(req.params.accId, '2016'); // TODO proper filtering
    res.write((await makeIncassoMail(account, trans)).html);
  } catch (e) {
    res.write('ERROR: ' + JSON.stringify(e));
  }
  res.end();
});

app.listen(3000,  () => {
  console.log('Listening on http://localhost:3000/');
  opn('http://localhost:3000/');
});
