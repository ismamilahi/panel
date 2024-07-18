/**
 * @fileoverview This module sets up the authentication routes using Passport for user
 * authentication with a local strategy. It handles user login, logout, and registration processes.
 * User credentials are verified against a custom database handler, and sessions are managed
 * through Passport's session handling.
 */

const express = require('express');
const passport = require('passport');
const config = require('../config.json');
const LocalStrategy = require('passport-local').Strategy;
const { v4: uuidv4 } = require('uuid');
const { db } = require('../handlers/db.js');
const { sendEmail } = require('../handlers/smtp.js');
const bcrypt = require('bcrypt');
const saltRounds = 10;

const router = express.Router();

// Initialize passport
router.use(passport.initialize());
router.use(passport.session());

/**
 * Configures Passport's local strategy for user authentication. It checks the provided
 * username (or email) and password against stored credentials in the database. If the credentials
 * match, the user is authenticated; otherwise, appropriate error messages are returned.
 *
 * @returns {void} No return value but configures the local authentication strategy.
 */
passport.use(new LocalStrategy(
  async (username, password, done) => {
    try {
      const settings = await db.get('settings') || {};
      const users = await db.get('users');
      if (!users) {
        return done(null, false, { message: 'No users found.' });
      }

      const isEmail = username.includes('@');

      let user;
      if (isEmail) {
        user = users.find(user => user.email === username);
      } else {
        user = users.find(user => user.username === username);
      }

      if (!user) {
        return done(null, false, { message: 'Incorrect username or email.' });
      }

      if (settings.forceVerify && !user.verified) {
        return done(null, false, { message: 'Email not verified. Please verify your email.', userNotVerified: true });
      }

      const match = await bcrypt.compare(password, user.password);
      if (match) {
        return done(null, user);
      } else {
        return done(null, false, { message: 'Incorrect password.' });
      }
    } catch (error) {
      return done(error);
    }
  }
));


async function doesUserExist(username) {
  const users = await db.get('users');
  if (users) {
    return users.some(user => user.username === username);
  } else {
    return false; // If no users found, return false
  }
}

async function doesEmailExist(email) {
  const users = await db.get('users');
  if (users) {
    return users.some(user => user.email === email);
  } else {
    return false; // If no users found, return false
  }
}

async function createUser(username, email, password) {
  const settings = await db.get('settings') || {};
  const emailVerificationEnabled = settings.forceVerify || false;

  if (emailVerificationEnabled) {
    return addUserToUsersTable(username, email, password, false);
  } else {
    return addUserToUsersTable(username, email, password, true);
  }
}

async function addUserToUsersTable(username, email, password, verified) {
  try {
    const appName = await db.get('name') || 'Skyport';
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const userId = uuidv4();
    const verificationToken = verified ? null : generateRandomCode(30);
    let users = await db.get('users') || [];
    const newUser = { userId, username, email, password: hashedPassword, "Accesto":[], admin: false, verified, verificationToken, welcomeEmailSent: false };
    users.push(newUser);
    await db.set('users', users);

    if (!newUser.welcomeEmailSent) {
      await sendEmail(email, `Welcome to ${appName}`, { 
          subject: `Welcome to ${appName}`,
          message: `You Just Creating Account With Us, Here is Login link:`,
          buttonUrl: `${config.baseURL}/login`,
          buttonText: 'Login Now',
          footer: `We hope you enjoy using ${appName}`,
          name: appName,
       });    
      newUser.welcomeEmailSent = true;

      if (!verified) {
        await sendEmail(email, 'Verify Your Email', {
          subject: 'Verify Your Email',
          message: `Thank you for registering on Skyport. Please click the button below to verify your email address:`,
          buttonUrl: `${config.baseURL}/verify/${verificationToken}`,
          buttonText: 'Verify Email Address',
          message_2: `If you're having trouble clicking the button above, you can also verify your email by copying and pasting the following link into your browser:`,
          message_2_link: `${config.baseURL}/verify/${verificationToken}`,
          footer: `If you didn't create an account on Skyport, please disregard this email.`,
          name: appName,
        });
        users = await db.get('users') || [];
        const index = users.findIndex(u => u.userId === newUser.userId);
        if (index !== -1) {
          users[index] = newUser;
          await db.set('users', users);
        }
      }
    }

    return users;
  } catch (error) {
    log.error('Error adding user to database:', error);
    throw error;
  }
}

/**
 * Serializes the user to the session, storing only the username to manage login sessions.
 * @param {Object} user - The user object from the database.
 * @param {Function} done - A callback function to call with the username.
 */
passport.serializeUser((user, done) => {
  done(null, user.username);
});

/**
 * Deserializes the user from the session by retrieving the full user details from the database
 * using the stored username. Necessary for loading user details on subsequent requests after login.
 * @param {string} username - The username stored in the session.
 * @param {Function} done - A callback function to call with the user object or errors if any.
 */
passport.deserializeUser(async (username, done) => {
  try {
    const users = await db.get('users');
    if (!users) {
      throw new Error('User not found');
    }
    
    // Search for the user with the provided username in the users array
    const foundUser = users.find(user => user.username === username);

    if (!foundUser) {
      throw new Error('User not found');
    }

    done(null, foundUser); // Deserialize user by retrieving full user details from the database
  } catch (error) {
    done(error);
  }
});

router.post('/auth/login', async (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) { return next(err); }
    if (!user) {
      if (info.userNotVerified) {
        return res.redirect('/login?err=UserNotVerified');
      }
      return res.redirect('/login?err=InvalidCredentials&state=failed');
    }
    req.logIn(user, (err) => {
      if (err) { return next(err); }
      return res.redirect('/instances');
    });
  })(req, res, next);
});


/**
 * GET /auth/login
 * Authenticates a user using Passport's local strategy. If authentication is successful, the user
 * is redirected to the instances page, otherwise, they are sent back to the login page with an error.
 *
 * @returns {Response} Redirects based on the success or failure of the authentication attempt.
 */
router.get('/auth/login', async (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) { return next(err); }
    if (!user) {
      if (info.userNotVerified) {
        return res.redirect('/login?err=UserNotVerified');
      }
      return res.redirect('/login?err=InvalidCredentials&state=failed');
    }
    req.logIn(user, (err) => {
      if (err) { return next(err); }
      return res.redirect('/instances');
    });
  })(req, res, next);
});

router.get('/auth/login', passport.authenticate('local', {
  successRedirect: '/instances',
  failureRedirect: '/login?err=InvalidCredentials&state=failed',
}));

router.get('/verify/:token', async (req, res) => {
  const { token } = req.params;
  try {
    let users = await db.get('users') || [];
    const user = users.find(u => u.verificationToken === token);
    if (user) {
      user.verified = true;
      user.verificationToken = null;
      await db.set('users', users);
      res.redirect('/login?msg=EmailVerified');
    } else {
      res.redirect('/login?msg=InvalidVerificationToken');
    }
  } catch (error) {
    log.error('Error verifying email:', error);
    res.status(500).send('Internal server error');
  }
});

router.get('/resend-verification', async (req, res) => {
  try {
    const name = await db.get('name') || 'Skyport';
    const logo = await db.get('logo') || false;

    res.render('auth/resend-verification', {
      req: req,
      name: name,
      logo: logo
    });
  } catch (error) {
    log.error('Error fetching name or logo:', error);
    res.status(500).send('Internal server error');
  }
});

router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;

  try {
    const appName = await db.get('name') || 'Skyport';
    let users = await db.get('users') || [];
    const userIndex = users.findIndex(u => u.email === email);

    if (userIndex === -1) {
      res.redirect('/login?msg=UserNotFound');
      return;
    }

    const user = users[userIndex];

    if (user.verified) {
      res.redirect('/login?msg=UserAlreadyVerified');
      return;
    }

    const newVerificationToken = generateRandomCode(30);
    user.verificationToken = newVerificationToken;

    users[userIndex] = user;
    await db.set('users', users);

    await sendEmail(email, 'Verify Your Email', {
      subject: 'Verify Your Email',
      message: `Thank you for registering on Skyport. Please click the button below to verify your email address:`,
      buttonUrl: `${config.baseURL}/verify/${newVerificationToken}`,
      buttonText: 'Verify Email Address',
      message_2: `If you're having trouble clicking the button above, you can also verify your email by copying and pasting the following link into your browser:`,
      message_2_link: `${config.baseURL}/verify/${newVerificationToken}`,
      footer: `If you didn't create an account on Skyport, please disregard this email.`,
      name: appName,
    });

    res.redirect('/login?msg=VerificationEmailResent');
  } catch (error) {
    log.error('Error resending verification email:', error);
    res.status(500).send('Internal server error');
  }
});

async function initializeRoutes() {
  async function updateRoutes() {
    try {
      const settings = await db.get('settings');

      if (!settings) {
        await db.set('settings', { forceVerify: false });
      } else {
        if (settings.forceVerify === true) {
          router.get('/register', async (req, res) => {
            try {
              res.render('auth/register', {
                req,
                user: req.user,
                name: await db.get('name') || 'Skyport',
                logo: await db.get('logo') || false
              });
            } catch (error) {
              log.error('Error fetching name or logo:', error);
              res.status(500).send('Internal server error');
            }
          });

          router.post('/auth/register', async (req, res) => {
            const { username, email, password } = req.body;

            try {
              const userExists = await doesUserExist(username);
              const emailExists = await doesEmailExist(email);

              if (userExists || emailExists) {
                res.send('User already exists');
                return;
              }

              await createUser(username, email, password);
              res.redirect('/login?msg=AccountcreateEmailSent');
            } catch (error) {
              log.error('Error handling registration:', error);
              res.status(500).send('Internal server error');
            }
          });
        } else {
          router.stack = router.stack.filter(
            r => !(r.route && (r.route.path === '/register' || r.route.path === '/auth/register'))
          );
        }
      }
    } catch (error) {
      log.error('Error initializing routes:', error);
    }
  }

  await updateRoutes();
  setInterval(updateRoutes, 1000);
}


initializeRoutes();

router.get('/auth/reset-password', async (req, res) => {
  try {
    const name = await db.get('name') || 'Skyport';
    const logo = await db.get('logo') || false;

    res.render('auth/reset-password', {
      req: req,
      name: name,
      logo: logo
    });
  } catch (error) {
    log.error('Error rendering reset password page:', error);
    res.status(500).send('Internal server error');
  }
});

router.post('/auth/reset-password', async (req, res) => {
  const { email } = req.body;

  try {
    const appName = await db.get('name') || 'Skyport';
    const users = await db.get('users') || [];
    const user = users.find(u => u.email === email);

    if (!user) {
      res.redirect('/auth/reset-password?err=EmailNotFound');
      return;
    }

    const resetToken = generateRandomCode(30);
    user.resetToken = resetToken;
    await db.set('users', users);

    await sendEmail(email, 'Password Reset Request', {
      subject: 'Password Reset Request',
      message: `You requested a password reset. Click the button below to reset your password:`,
      buttonUrl: `${config.baseURL}/auth/reset/${resetToken}`,
      buttonText: 'Reset Password',
      message_2: `If the button above does not work, click the link below:`,
      message_2_link: `${config.baseURL}/verify/${resetToken}`,
      footer: `If you did not request a password reset, please ignore this email. Your password will remain unchanged.`,
      name: appName,
    });

    res.redirect('/auth/reset-password?msg=PasswordSent');
  } catch (error) {
    console.error('Error handling password reset:', error);
    res.redirect('/auth/reset-password?msg=PasswordResetFailed');
  }
});

router.get('/auth/reset/:token', async (req, res) => {
  const { token } = req.params;

  try {
    const users = await db.get('users') || [];
    const name = await db.get('name') || 'Skyport';
    const logo = await db.get('logo') || false;
    const user = users.find(u => u.resetToken === token);

    if (!user) {
      res.send('Invalid or expired token.');
      return;
    }

    res.render('auth/password-reset-form', {
      req: req,
      name: name,
      logo: logo,
      token: token
    });
  } catch (error) {
    log.error('Error rendering password reset form:', error);
    res.status(500).send('Internal server error');
  }
});

router.post('/auth/reset/:token', async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  try {
    const users = await db.get('users') || [];
    if (!users) {
      throw new Error('No users found');
    }

    const user = users.find(user => user.resetToken === token);

    if (!user) {
      res.redirect('/login?msg=PasswordReset&state=failed');
      return;
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);
    user.password = hashedPassword;
    delete user.resetToken;
    await db.set('users', users);

    res.redirect('/login?msg=PasswordReset&state=success');
  } catch (error) {
    log.error('Error handling password reset:', error);
    res.redirect('/login?msg=PasswordReset&state=failed');
  }
});

function generateRandomCode(length) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

/**
 * GET /auth/logout
 * Logs out the user by ending the session and then redirects the user.
 *
 * @returns {Response} No specific return value but ends the user's session and redirects.
 */
router.get("/auth/logout", (req, res) => {
  req.logout(req.user, err => {
    if (err) return next(err);
    res.redirect("/");
  });
});

initializeRoutes().catch(error => {
  log.error('Error initializing routes:', error);
});


module.exports = router;
