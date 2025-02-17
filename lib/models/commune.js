const {pick, chain, keyBy, difference} = require('lodash')
const mongo = require('../util/mongo')
const {getCommuneActuelle, getRegion, getDepartement, getCommune: getCommuneCOG} = require('../util/cog')
const compositionQueue = require('../util/queue')('compose-commune')
const {prepareAdresse, prepareToponyme} = require('../formatters/geojson')

async function askComposition(codeCommune) {
  const communeActuelle = getCommuneActuelle(codeCommune)

  if (!communeActuelle) {
    throw new Error(`Impossible de trouver la commune actuelle descendante de ${codeCommune}`)
  }

  const now = new Date()
  await mongo.db.collection('communes').findOneAndUpdate(
    {codeCommune: communeActuelle.code},
    {$set: {compositionAskedAt: now}},
    {upsert: true}
  )
  await compositionQueue.add({codeCommune: communeActuelle.code, compositionAskedAt: now})
}

async function finishComposition(codeCommune) {
  await mongo.db.collection('communes').findOneAndUpdate(
    {codeCommune},
    {$unset: {compositionAskedAt: 1}}
  )
}

function getCommune(codeCommune) {
  return mongo.db.collection('communes').findOne({codeCommune})
}

function getAskedComposition() {
  return mongo.db.collection('communes').distinct('codeCommune', {compositionAskedAt: {$exists: true}})
}

async function updateCommune(codeCommune, changes) {
  await mongo.db.collection('communes').findOneAndUpdate({codeCommune}, {$set: changes})
}

async function updateCommunesForceCertification(forceCertificationList) {
  const currentList = await mongo.db.collection('communes').distinct('codeCommune', {forceCertification: true})

  const toRemoveList = difference(currentList, forceCertificationList)
  const toAddList = difference(forceCertificationList, currentList)

  await mongo.db.collection('communes').updateMany(
    {codeCommune: {$in: toRemoveList}},
    {$set: {forceCertification: false}}
  )

  await mongo.db.collection('communes').updateMany(
    {codeCommune: {$in: toAddList}},
    {$set: {forceCertification: true}}
  )

  await Promise.all([...toRemoveList, ...toAddList].map(codeCommune => askComposition(codeCommune)))

  return {communesAdded: toAddList, communesRemoved: toRemoveList}
}

async function saveCommuneData(codeCommune, {commune, voies, numeros}) {
  await Promise.all([
    mongo.db.collection('voies').deleteMany({codeCommune}),
    mongo.db.collection('numeros').deleteMany({codeCommune})
  ])

  await updateCommune(codeCommune, commune)

  if (voies && voies.length > 0) {
    await mongo.db.collection('voies').insertMany(voies, {ordered: false})
  }

  if (numeros && numeros.length > 0) {
    await mongo.db.collection('numeros').insertMany(numeros, {ordered: false})
  }
}

async function getCommuneData(codeCommune) {
  const [voies, numeros] = await Promise.all([
    mongo.db.collection('voies').find({codeCommune}).toArray(),
    mongo.db.collection('numeros').find({codeCommune}).toArray()
  ])

  return {voies, numeros}
}

function fieldsToProj(fields) {
  return fields.reduce((acc, item) => {
    acc[item] = 1
    return acc
  }, {_id: 0})
}

async function getCommunesSummary() {
  const communeFields = [
    'nomCommune',
    'codeCommune',
    'departement',
    'region',
    'nbLieuxDits',
    'nbNumeros',
    'nbNumerosCertifies',
    'nbVoies',
    'population',
    'typeComposition',
    'analyseAdressage'
  ]
  const communesSummaries = await mongo.db.collection('communes')
    .find({})
    .project(fieldsToProj(communeFields))
    .sort({codeCommune: 1})
    .toArray()

  return communesSummaries.map(c => ({
    ...c,
    departement: c.departement.code,
    region: c.region.code
  }))
}

async function getPopulatedCommune(codeCommune) {
  const communeFields = [
    'codeCommune',
    'nomCommune',
    'departement',
    'region',
    'codesPostaux',
    'population',
    'typeCommune',
    'nbNumeros',
    'nbNumerosCertifies',
    'nbVoies',
    'nbLieuxDits',
    'typeComposition',
    'displayBBox'
  ]

  const commune = await mongo.db.collection('communes')
    .findOne({codeCommune}, {projection: fieldsToProj(communeFields)})

  if (!commune) {
    return
  }

  const voiesFields = ['type', 'idVoie', 'nomVoie', 'sourceNomVoie', 'sources', 'nbNumeros', 'nbNumerosCertifies']

  const voies = await mongo.db.collection('voies')
    .find({codeCommune}, {projection: fieldsToProj(voiesFields)})
    .toArray()

  return {
    id: commune.codeCommune,
    type: 'commune',
    ...pick(commune, communeFields),
    voies: voies.map(v => ({id: v.idVoie, ...v}))
  }
}

async function getPopulatedVoie(idVoie) {
  const voieFields = ['type', 'idVoie', 'nomVoie', 'sourceNomVoie', 'sources', 'codeCommune', 'nbNumeros', 'nbNumerosCertifies', 'displayBBox']

  const voie = await mongo.db.collection('voies')
    .findOne({idVoie}, {projection: fieldsToProj(voieFields)})

  if (!voie) {
    return
  }

  const commune = getCommuneCOG(voie.codeCommune)
  const communeFields = ['nom', 'code', 'departement', 'region']

  const numerosFields = ['numero', 'suffixe', 'lieuDitComplementNom', 'parcelles', 'sources', 'position', 'positionType', 'sourcePosition', 'certifie', 'codePostal', 'libelleAcheminement', 'id']

  const numeros = await mongo.db.collection('numeros')
    .find({idVoie})
    .project(fieldsToProj(numerosFields))
    .sort({cleInterop: 1})
    .toArray()

  return {
    id: voie.idVoie,
    ...voie,
    codeCommune: undefined,
    commune: {
      id: commune.code,
      ...pick(commune, communeFields),
      departement: pick(getDepartement(commune.departement), 'nom', 'code'),
      region: pick(getRegion(commune.region), 'nom', 'code')
    },
    numeros
  }
}

async function getPopulatedNumero(id) {
  const numero = await mongo.db.collection('numeros').findOne({id}, {projection: {_id: 0}})

  if (!numero) {
    return
  }

  const commune = getCommuneCOG(numero.codeCommune)
  const communeFields = ['nom', 'code', 'departement', 'region']

  const voieFields = ['idVoie', 'nomVoie']
  const voie = await mongo.db.collection('voies')
    .findOne({idVoie: numero.idVoie}, {projection: fieldsToProj(voieFields)})

  return {
    type: 'numero',
    ...numero,
    voie: {id: voie.idVoie, ...voie},
    commune: {
      id: commune.code,
      ...pick(commune, communeFields),
      departement: pick(getDepartement(commune.departement), 'nom', 'code'),
      region: pick(getRegion(commune.region), 'nom', 'code')
    },
    codeCommune: undefined,
    idVoie: undefined
  }
}

async function getAdressesFeatures(z, x, y) {
  const projection = {adressesOriginales: 0}
  const numeros = await mongo.db.collection('numeros').find({tiles: `${z}/${x}/${y}`}, {projection}).toArray()
  const idsVoies = chain(numeros).map('idVoie').uniq().value()
  const voies = await mongo.db.collection('voies').find({idVoie: {$in: idsVoies}}).toArray()
  const voiesIndex = keyBy(voies, 'idVoie')
  const features = numeros.map(n => {
    const v = voiesIndex[n.idVoie]
    return prepareAdresse(n, v)
  })

  return features
}

async function getToponymesFeatures(z, x, y) {
  const voies = await mongo.db.collection('voies').find({tiles: `${z}/${x}/${y}`}).toArray()
  return voies.map(v => prepareToponyme(v))
}

module.exports = {
  askComposition,
  getAskedComposition,
  finishComposition,
  getCommune,
  saveCommuneData,
  getCommuneData,
  getPopulatedNumero,
  getPopulatedCommune,
  getPopulatedVoie,
  getAdressesFeatures,
  getToponymesFeatures,
  getCommunesSummary,
  updateCommunesForceCertification
}
