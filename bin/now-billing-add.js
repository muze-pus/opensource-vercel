#!/usr/bin/env node

const ansiEscapes = require('ansi-escapes')
const chalk = require('chalk')
const ccValidator = require('credit-card')

const textInput = require('../lib/utils/input/text')
const countries = require('../lib/utils/billing/country-list')
const cardBrands = require('../lib/utils/billing/card-brands')
const geocode = require('../lib/utils/billing/geocode')
const success = require('../lib/utils/output/success')
const wait = require('../lib/utils/output/wait')

function rightPad(string, n = 12) {
  n -= string.length
  return string + ' '.repeat(n > -1 ? n : 0)
}

function expDateMiddleware(data) {
  return data
}

module.exports = function (creditCards) {
  const state = {
    error: undefined,
    cardGroupLabel: `> ${chalk.bold('Enter your card details')}`,

    name: {
      label: rightPad('Name'),
      placeholder: 'John Appleseed',
      validateValue: data => data.trim().length > 0
    },

    cardNumber: {
      label: rightPad('Number'),
      mask: 'cc',
      placeholder: '#### #### #### ####',
      validateKeypress: (data, value) => (
        /\d/.test(data) && value.length < 19
      ),
      validateValue: data => {
        data = data.replace(/ /g, '')
        const type = ccValidator.determineCardType(data)
        if (!type) {
          return false
        }
        return ccValidator.isValidCardNumber(data, type)
      }
    },

    ccv: {
      label: rightPad('CCV'),
      mask: 'ccv',
      placeholder: '###',
      validateValue: data => {
        const brand = state.cardNumber.brand.toLowerCase()
        return ccValidator.doesCvvMatchType(data, brand)
      }
    },

    expDate: {
      label: rightPad('Exp. Date'),
      mask: 'expDate',
      placeholder: 'mm / yyyy',
      middleware: expDateMiddleware,
      validateValue: data => !ccValidator.isExpired(...data.split(' / '))
    },

    addressGroupLabel: `\n> ${chalk.bold('Enter your billing address')}`,

    country: {
      label: rightPad('Country'),
      async autoComplete(value) {
        for (const country in countries) {
          if (!Object.hasOwnProperty.call(countries, country)) {
            continue
          }
          if (country.startsWith(value)) {
            return country.substr(value.length)
          }
        }
        return false
      },
      validateValue: value => countries[value] !== undefined
    },

    zipCode: {
      label: rightPad('ZIP'),
      validadeKeypress: data => data.trim().length > 0,
      validateValue: data => data.trim().length > 0
    },

    state: {
      label: rightPad('State'),
      validateValue: data => data.trim().length > 0
    },

    city: {
      label: rightPad('City'),
      validateValue: data => data.trim().length > 0
    },

    address1: {
      label: rightPad('Address'),
      validateValue: data => data.trim().length > 0
    }
  }

  async function render() {
    for (const key in state) {
      if (!Object.hasOwnProperty.call(state, key)) {
        continue
      }
      const piece = state[key]
      if (typeof piece === 'string') {
        console.log(piece)
      } else if (typeof piece === 'object') {
        let result
        try {
          result = await textInput({
            label: '- ' + piece.label,
            initialValue: piece.initialValue || piece.value,
            placeholder: piece.placeholder,
            mask: piece.mask,
            validateKeypress: piece.validateKeypress,
            validateValue: piece.validateValue,
            autoComplete: piece.autoComplete
          })
          piece.value = result
          if (key === 'cardNumber') {
            let brand = cardBrands[ccValidator.determineCardType(result)]
            piece.brand = brand
            if (brand === 'American Express') {
              state.ccv.placeholder = '#'.repeat(4)
            } else {
              state.ccv.placeholder = '#'.repeat(3)
            }
            brand = chalk.cyan(`[${brand}]`)
            const masked = chalk.gray('#### '.repeat(3)) + result.split(' ')[3]
            process.stdout.write(
              `${chalk.cyan('✓')} ${piece.label}${masked} ${brand}\n`
            )
          } else if (key === 'ccv') {
            process.stdout.write(
              `${chalk.cyan('✓')} ${piece.label}${'*'.repeat(result.length)}\n`
            )
          } else if (key === 'expDate') {
            let text = result.split(' / ')
            text = text[0] + chalk.gray(' / ') + text[1]
            process.stdout.write(`${chalk.cyan('✓')} ${piece.label}${text}\n`)
          } else if (key === 'zipCode') {
            const stopSpinner = wait(piece.label + result)
            const addressInfo = await geocode({
              country: state.country.value,
              zipCode: result
            })
            if (addressInfo.state) {
              state.state.initialValue = addressInfo.state
            }
            if (addressInfo.city) {
              state.city.initialValue = addressInfo.city
            }
            stopSpinner()
            process.stdout.write(`${chalk.cyan('✓')} ${piece.label}${result}\n`)
          } else {
            process.stdout.write(`${chalk.cyan('✓')} ${piece.label}${result}\n`)
          }
        } catch (err) {
          if (err.message === 'USER_ABORT') {
            process.exit(1)
          } else {
            console.error(err)
          }
        }
      }
    }
    console.log('') // new line
    const stopSpinner = wait('Saving card')

    try {
      const res = await creditCards.add({
        name: state.name.value,
        cardNumber: state.cardNumber.value,
        ccv: state.ccv.value,
        expDate: state.expDate.value,
        country: state.country.value,
        zipCode: state.zipCode.value,
        state: state.state.value,
        city: state.city.value,
        address1: state.address1.value
      })
      stopSpinner()
      success(`${state.cardNumber.brand} ending in ${res.last4} was added to your account`)
    } catch (err) {
      stopSpinner()
      const linesToClear = state.error ? 13 : 12
      process.stdout.write(ansiEscapes.eraseLines(linesToClear))
      state.error = `${chalk.red('> Error!')} ${err.message} Please make sure the info is correct`
      await render()
    }
  }

  render().catch(console.error)
}
